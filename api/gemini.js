/*
 * Gemini 중계 (Vercel 서버리스 함수)
 *
 * 왜 이렇게 두었나
 *   저장소가 공개돼 있어서 API 키를 코드에 넣으면 그대로 털린다.
 *   브라우저에서 Gemini 를 직접 부르면 키가 사용자 쪽에 노출된다.
 *   그래서 키는 Vercel 환경변수에만 두고, 이 함수가 대신 부른다.
 *   쓰는 사람은 키를 입력할 필요도, 볼 일도 없다.
 *
 * 관리자가 넣을 환경변수 (Vercel → Settings → Environment Variables)
 *   GEMINI_API_KEY      (필수)  발급받은 키
 *   GEMINI_TEXT_MODEL     (선택)  기본값은 아래 DEFAULT_TEXT_MODEL
 *   GEMINI_FALLBACK_MODEL (선택)  본 모델이 계속 붐빌 때 대신 쓸 모델
 *
 * 요청:  POST /api/gemini   { kind: "analyze", body: { ... } }
 * 응답:  Gemini 응답을 그대로 전달 (상태 코드 포함)
 *
 * 모델 이름은 서버가 정한다. 브라우저가 보낸 값은 쓰지 않는다.
 *
 * 모델이 바뀔 때
 *   구글은 옛 모델을 닫으면서 "models/XXX 를 쓰라"고 알려 준다.
 *   그 경우 알려준 모델로 한 번만 다시 시도한다. 모델명이 바뀌어도
 *   코드를 고치지 않고 계속 돌아가게 하려는 것이다.
 */

const DEFAULT_TEXT_MODEL = 'gemini-3.8-flash';
const MODELS = {
  analyze: () => process.env.GEMINI_TEXT_MODEL || DEFAULT_TEXT_MODEL
};
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY = 4 * 1024 * 1024; // Vercel 요청 본문 한도(4.5MB)보다 조금 작게

/* 붐빌 때(503)·잠깐 막힐 때(429) 기다렸다 다시 부른다.
   사람이 버튼을 다시 누르지 않아도 되도록 서버가 알아서 처리한다.
   vercel.json 의 maxDuration 60초 안에 끝나도록 간격을 잡았다. */
const RETRY_WAIT_MS = [1200, 3000, 6000];
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function callUpstream(model, key, forward) {
  return fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: forward
    }
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { message: 'POST 로만 요청할 수 있습니다.' } });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: { message:
      '서버에 GEMINI_API_KEY 가 설정되지 않았습니다.' } });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: { message: '요청 형식이 올바르지 않습니다.' } });
  }

  const pickModel = MODELS[payload.kind];
  if (!pickModel) {
    return res.status(400).json({ error: { message: '알 수 없는 요청입니다.' } });
  }
  const model = pickModel();
  if (!MODEL_RE.test(model)) {
    return res.status(500).json({ error: { message:
      'GEMINI_TEXT_MODEL 값이 올바르지 않습니다: ' + model } });
  }

  const { body } = payload;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: { message: '보낼 내용이 없습니다.' } });
  }

  const forward = JSON.stringify(body);
  if (forward.length > MAX_BODY) {
    return res.status(413).json({ error: { message:
      '보낸 내용이 너무 큽니다. 사진 수를 줄이거나 원고를 짧게 해 주세요.' } });
  }

  try {
    let upstream = await callUpstream(model, key, forward);
    let text = await upstream.text();
    let used = model;
    let tries = 1;

    /* "models/XXX 를 쓰라" 는 안내가 오면 그 모델로 한 번만 다시 시도 */
    if (!upstream.ok) {
      const hint = /models\/([A-Za-z0-9._-]+)/g;
      const names = [];
      let m;
      while ((m = hint.exec(text))) if (m[1] !== model && !names.includes(m[1])) names.push(m[1]);
      const next = names[names.length - 1];   // 안내문에서 권하는 쪽은 뒤에 나온다
      if (next && MODEL_RE.test(next)) {
        const retry = await callUpstream(next, key, forward);
        const retryText = await retry.text();
        tries++;
        if (retry.ok) { upstream = retry; text = retryText; used = next; }
      }
    }

    /* 붐비거나 일시적으로 실패하면 조금 기다렸다 다시 부른다 */
    for (let i = 0; i < RETRY_WAIT_MS.length && !upstream.ok && RETRY_STATUS.has(upstream.status); i++) {
      await sleep(RETRY_WAIT_MS[i]);
      const again = await callUpstream(used, key, forward);
      const againText = await again.text();
      tries++;
      upstream = again; text = againText;
    }

    /* 그래도 붐비면, 관리자가 지정해 둔 예비 모델로 한 번 더 */
    const spare = process.env.GEMINI_FALLBACK_MODEL;
    if (!upstream.ok && RETRY_STATUS.has(upstream.status) && spare && MODEL_RE.test(spare) && spare !== used) {
      const alt = await callUpstream(spare, key, forward);
      const altText = await alt.text();
      tries++;
      if (alt.ok) { upstream = alt; text = altText; used = spare; }
    }

    res.setHeader('X-Model-Tries', String(tries));
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Model-Used', used);
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: { message:
      'AI 서버에 연결하지 못했습니다: ' + (e && e.message ? e.message : String(e)) } });
  }
};

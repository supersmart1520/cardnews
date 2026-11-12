/*
 * Gemini 중계 (Vercel 서버리스 함수)
 *
 * 왜 필요한가
 *   이 저장소는 공개돼 있어서 API 키를 코드에 넣으면 그대로 털린다.
 *   브라우저에서 Gemini 를 직접 부르면 키가 사용자 쪽에 노출된다.
 *   그래서 키는 Vercel 환경변수(GEMINI_API_KEY)에만 두고,
 *   이 함수가 대신 불러서 결과만 돌려준다.
 *
 * 쓰는 법
 *   Vercel → 프로젝트 → Settings → Environment Variables 에
 *   GEMINI_API_KEY = <발급받은 키> 를 넣고 다시 배포하면 된다.
 *
 * 요청:  POST /api/gemini   { model: "gemini-2.5-flash", body: { ... } }
 * 응답:  Gemini 응답을 그대로 전달 (상태 코드 포함)
 */

const ALLOWED_MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY = 4 * 1024 * 1024; // Vercel 요청 본문 한도(4.5MB)보다 조금 작게

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

  const { model, body } = payload;
  if (!model || !ALLOWED_MODEL.test(model)) {
    return res.status(400).json({ error: { message: '모델 이름이 올바르지 않습니다.' } });
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: { message: 'body 가 필요합니다.' } });
  }

  const forward = JSON.stringify(body);
  if (forward.length > MAX_BODY) {
    return res.status(413).json({ error: { message:
      '보낸 내용이 너무 큽니다. 사진 수를 줄이거나 원고를 짧게 해 주세요.' } });
  }

  try {
    const upstream = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/'
        + encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: forward
      }
    );
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: { message:
      'Gemini 에 연결하지 못했습니다: ' + (e && e.message ? e.message : String(e)) } });
  }
};

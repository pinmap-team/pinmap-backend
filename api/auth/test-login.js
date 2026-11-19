// The explicitly configured team test user; credentials stay on the server.
const {projectUrl, publicKey} = require('./config');
const {getKey} = require('../../config/keys.cjs');
const EMAIL = 'pinmap2026@gmail.com';
function enabled() {
  return process.env.PINMAP_TEST_LOGIN_ENABLED === 'true' && (process.env.PINMAP_TEST_LOGIN_PASSWORD || '').length >= 8;
}
async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  if (!enabled()) return res.status(404).json({error:'테스트 로그인이 열려 있지 않아요.'});
  if (req.body && Object.keys(req.body).length) return res.status(400).json({error:'입력값 없이 다시 시도해 주세요.'});
  const url = projectUrl(process.env.SUPABASE_URL);
  const key = publicKey(getKey('SUPABASE_PUBLISHABLE_KEY'));
  if (!url || !key) return res.status(503).json({error:'테스트 로그인을 준비 중이에요.'});
  const password = process.env.PINMAP_TEST_LOGIN_PASSWORD;
  async function request(path, body, apiKey = key) {
    const response = await fetch(url + path, {method:'POST', headers:{apikey:apiKey,'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    return {ok:response.ok, data:await response.json()};
  }
  try {
    const result = await request('/auth/v1/token?grant_type=password', {email:EMAIL,password});
    const session = result.data;
    if (!result.ok || session.user?.email !== EMAIL || session.user?.is_anonymous !== false || !session.access_token || !session.refresh_token) throw new Error('TEST_LOGIN');
    return res.status(200).json({access_token:session.access_token,refresh_token:session.refresh_token});
  } catch {
    return res.status(503).json({error:'테스트 계정에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'});
  }
}
module.exports = handler;
module.exports.enabled = enabled;

const { projectUrl, publicKey } = require('./auth/config');
const { extractionRequest, extractorConfig, forwardExtraction } = require('./place-extract');

function supabaseConfig(env = process.env) {
  const origin = projectUrl(env.SUPABASE_URL);
  const key = publicKey(env.SUPABASE_PUBLISHABLE_KEY);
  return origin && key ? { origin, key } : null;
}

function bearerToken(value) {
  const match = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(String(value || ''));
  return match ? match[1] : null;
}

async function authenticatedUser(config, token, fetcher = fetch) {
  try {
    const response = await fetcher(new URL('/auth/v1/user', config.origin), {
      headers: { apikey: config.key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { status: response.status === 401 || response.status === 403 ? 401 : 503 };
    const user = await response.json();
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(user?.id || '')) {
      return { status: 401 };
    }
    // Only explicitly permanent Supabase accounts may request extraction.
    if (user.is_anonymous !== false) return { status: 403 };
    return { status: 200, userId: user.id };
  } catch {
    return { status: 503 };
  }
}

module.exports = async function contentExtract(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Authorization');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const config = supabaseConfig();
  if (!config || !extractorConfig()) return res.status(503).json({ error: 'content_extraction_not_configured' });
  let payload;
  try { payload = extractionRequest(req.body, ['place', 'event']); }
  catch { return res.status(400).json({ error: 'invalid_request' }); }
  const token = bearerToken(req.headers.authorization);
  if (!token) return res.status(401).json({ error: 'authentication_required' });
  const auth = await authenticatedUser(config, token);
  if (auth.status !== 200) return res.status(auth.status).json({ error: auth.status === 503 ? 'auth_unavailable' : 'authentication_required' });
  const forwarded = await forwardExtraction(payload);
  return res.status(forwarded.status).json(forwarded.body);
};

module.exports.supabaseConfig = supabaseConfig;
module.exports.bearerToken = bearerToken;
module.exports.authenticatedUser = authenticatedUser;

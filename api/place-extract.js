const crypto = require('node:crypto');

const MAX_EXTRACTOR_RESPONSE_BYTES = 12 * 1024 * 1024;

function equalSecret(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function instagramLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_link');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) ||
      url.username || url.password || !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error('Instagram 게시물 또는 릴스 링크가 필요합니다.');
  }
  return `https://www.instagram.com${url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'}`;
}

function contentTypes(value, defaults) {
  if (value === undefined) return defaults;
  if (!Array.isArray(value) || !value.length || value.length > 2 ||
      value.some(type => !['place', 'event'].includes(type)) || new Set(value).size !== value.length) {
    throw new Error('invalid_content_types');
  }
  return value;
}

function extractionRequest(body, defaults = ['place']) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
  return { url: instagramLink(parsed.url), content_types: contentTypes(parsed.content_types, defaults) };
}

function extractorConfig(env = process.env) {
  const token = env.PINMAP_EXTRACTOR_TOKEN;
  let target;
  try { target = new URL(env.PINMAP_EXTRACTOR_ORIGIN); } catch { return null; }
  if (!token || target.protocol !== 'https:' || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) return null;
  return { target: new URL('/extract-link', target), token };
}

async function readJsonLimited(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_EXTRACTOR_RESPONSE_BYTES) throw new Error('response_too_large');
  let bytes = 0;
  const chunks = [];
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_EXTRACTOR_RESPONSE_BYTES) throw new Error('response_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_EXTRACTOR_RESPONSE_BYTES) throw new Error('response_too_large');
  return JSON.parse(raw);
}

async function forwardExtraction(payload, { env = process.env, fetcher = fetch, timeoutMs = 270000 } = {}) {
  const config = extractorConfig(env);
  if (!config) return { status: 503, body: { error: 'extractor_not_configured' } };
  try {
    const response = await fetcher(config.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { status: 502, body: { error: 'extractor_rejected', upstream_status: response.status } };
    const result = await readJsonLimited(response);
    if (!result || !Array.isArray(result.results)) throw new Error('invalid_extractor_response');
    return { status: 200, body: result };
  } catch (error) {
    return { status: error?.name === 'TimeoutError' ? 504 : 502,
      body: { error: error?.name === 'TimeoutError' ? 'extractor_timeout' : 'extractor_unavailable' } };
  }
}

module.exports = async function placeExtract(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!extractorConfig() || !process.env.PINMAP_TEST_ACCESS_CODE) {
    return res.status(503).json({ error: 'online_test_not_configured' });
  }
  if (!equalSecret(req.headers['x-pinmap-test-code'], process.env.PINMAP_TEST_ACCESS_CODE)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  let payload;
  try { payload = extractionRequest(req.body, ['place']); }
  catch { return res.status(400).json({ error: 'invalid_request' }); }
  const forwarded = await forwardExtraction(payload);
  return res.status(forwarded.status).json(forwarded.body);
};

module.exports.instagramLink = instagramLink;
module.exports.contentTypes = contentTypes;
module.exports.extractionRequest = extractionRequest;
module.exports.extractorConfig = extractorConfig;
module.exports.forwardExtraction = forwardExtraction;

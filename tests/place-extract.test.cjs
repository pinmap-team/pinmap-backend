const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/place-extract');

function response() {
  return { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
async function request(method, code, body) {
  const res = response();
  await handler({ method, headers: {'x-pinmap-test-code':code}, body }, res);
  return res;
}
test('accepts only canonical Instagram post and reel paths', () => {
  assert.equal(handler.instagramLink('https://instagram.com/reel/Ab_12-3/?utm_source=x'), 'https://www.instagram.com/reel/Ab_12-3/');
  for (const url of ['http://instagram.com/p/a/', 'https://evil.example/p/a/', 'https://instagram.com/p/a/../../x', 'https://instagram.com.evil.example/p/a/']) {
    assert.throws(() => handler.instagramLink(url));
  }
});
test('rejects invalid requests before contacting the extractor', async () => {
  const names = ['PINMAP_EXTRACTOR_ORIGIN','PINMAP_EXTRACTOR_TOKEN','PINMAP_TEST_ACCESS_CODE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch;
  let calls = 0;
  try {
    process.env.PINMAP_EXTRACTOR_ORIGIN = 'https://backend.example';
    process.env.PINMAP_EXTRACTOR_TOKEN = 'backend-secret';
    process.env.PINMAP_TEST_ACCESS_CODE = 'access-secret';
    global.fetch = async () => { calls++; throw Error('Unexpected network'); };
    assert.equal((await request('GET', 'access-secret', {})).code, 405);
    assert.equal((await request('POST', 'wrong', {url:'https://instagram.com/p/abc/'})).code, 401);
    assert.equal((await request('POST', 'access-secret', {url:'https://elsewhere.example/p/abc/'})).code, 400);
    assert.equal(calls, 0);
  } finally {
    global.fetch = previousFetch;
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name];
  }
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/content-extract');

const names = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'PINMAP_EXTRACTOR_ORIGIN', 'PINMAP_EXTRACTOR_TOKEN'];
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature';
const post = 'https://www.instagram.com/p/Example123/';
const user = {id: '123e4567-e89b-42d3-a456-426614174000', is_anonymous: false};

function response() {
  return {code: 200, headers: {}, setHeader(name, value) {this.headers[name] = value; return this;},
    status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
}

function configure() {
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  process.env.PINMAP_EXTRACTOR_ORIGIN = 'https://extractor.example.test';
  process.env.PINMAP_EXTRACTOR_TOKEN = 'private-extractor-token';
  return () => {for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name];};
}

function jsonReply(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

test('official endpoint verifies Supabase user, atomically claims quota, and requests both content types', async () => {
  const restore = configure(), originalFetch = global.fetch, calls = [];
  try {
    global.fetch = async (url, options) => {
      calls.push({url: String(url), options});
      if (String(url).endsWith('/auth/v1/user')) return jsonReply(user);
      if (String(url).endsWith('/rpc/pinmap_claim_content_extraction')) return jsonReply({allowed: true, remaining: 4});
      if (String(url).endsWith('/extract-link')) return jsonReply({schema_version: 1, results: [{places: [], events: []}]});
      throw new Error('Unexpected URL');
    };
    const res = response();
    await handler({method: 'POST', headers: {authorization: `Bearer ${token}`}, body: {url: post}}, res);
    assert.equal(res.code, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[2].options.headers.Authorization, 'Bearer private-extractor-token');
    assert.deepEqual(JSON.parse(calls[2].options.body), {url: post, content_types: ['place', 'event']});
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert(!JSON.stringify(res.body).includes('private-extractor-token'));
  } finally {global.fetch = originalFetch; restore();}
});

test('official endpoint rejects invalid input and missing credentials before any network call', async () => {
  const restore = configure(), originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => {calls++; throw new Error('unexpected network');};
    let res = response();
    await handler({method: 'GET', headers: {}, body: {}}, res); assert.equal(res.code, 405);
    res = response();
    await handler({method: 'POST', headers: {}, body: {url: 'https://example.org/p/a/'}}, res); assert.equal(res.code, 400);
    res = response();
    await handler({method: 'POST', headers: {}, body: {url: post}}, res); assert.equal(res.code, 401);
    res = response();
    await handler({method: 'POST', headers: {authorization: `Bearer ${token}`}, body: {url: post, content_types: ['event', 'event']}}, res);
    assert.equal(res.code, 400);
    assert.equal(calls, 0);
  } finally {global.fetch = originalFetch; restore();}
});

test('quota denial and missing quota RPC stop expensive extraction', async () => {
  const restore = configure(), originalFetch = global.fetch;
  try {
    for (const quotaStatus of [429, 503]) {
      let extractorCalls = 0;
      global.fetch = async url => {
        if (String(url).endsWith('/auth/v1/user')) return jsonReply(user);
        if (String(url).endsWith('/rpc/pinmap_claim_content_extraction')) {
          return quotaStatus === 429 ? jsonReply({allowed: false, remaining: 0}) : jsonReply({message: 'missing function'}, 404);
        }
        extractorCalls++; throw new Error('extractor must not run');
      };
      const res = response();
      await handler({method: 'POST', headers: {authorization: `Bearer ${token}`}, body: {url: post}}, res);
      assert.equal(res.code, quotaStatus);
      assert.equal(extractorCalls, 0);
    }
  } finally {global.fetch = originalFetch; restore();}
});

test('failed Supabase verification never consumes quota', async () => {
  const restore = configure(), originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => {calls++; return jsonReply({message: 'invalid token'}, 401);};
    const res = response();
    await handler({method: 'POST', headers: {authorization: `Bearer ${token}`}, body: {url: post}}, res);
    assert.equal(res.code, 401);
    assert.equal(calls, 1);
  } finally {global.fetch = originalFetch; restore();}
});

test('anonymous and incomplete user records cannot consume quota', async () => {
  const restore = configure(), originalFetch = global.fetch;
  try {
    for (const candidate of [{...user, is_anonymous: true}, {id: user.id}]) {
      let calls = 0;
      global.fetch = async () => {calls++; return jsonReply(candidate);};
      const res = response();
      await handler({method: 'POST', headers: {authorization: `Bearer ${token}`}, body: {url: post}}, res);
      assert.equal(res.code, 403);
      assert.equal(calls, 1);
    }
  } finally {global.fetch = originalFetch; restore();}
});

test('rate-limit retry time follows the next Seoul midnight', () => {
  const at = Date.parse('2026-11-16T14:59:59Z'); // 23:59:59 KST
  assert.equal(handler.secondsUntilSeoulMidnight(at), 1);
  assert.equal(handler.secondsUntilSeoulMidnight(at + 1000), 86400);
});

test('event-only request reaches extractor without leaking a rejected upstream body', async () => {
  const restore = configure(), originalFetch = global.fetch;
  let submitted;
  try {
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/auth/v1/user')) return jsonReply(user);
      if (String(url).endsWith('/rpc/pinmap_claim_content_extraction')) return jsonReply({allowed: true, remaining: 3});
      submitted = JSON.parse(options.body);
      return new Response('internal extractor trace', {status: 500});
    };
    const res = response();
    await handler({method: 'POST', headers: {authorization: `Bearer ${token}`},
      body: {url: post, content_types: ['event']}}, res);
    assert.deepEqual(submitted.content_types, ['event']);
    assert.equal(res.code, 502);
    assert(!JSON.stringify(res.body).includes('internal extractor trace'));
  } finally {global.fetch = originalFetch; restore();}
});

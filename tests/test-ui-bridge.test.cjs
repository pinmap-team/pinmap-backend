const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the completed report reaches only the opened official prototype, without the test code', async () => {
  const listeners = {};
  const form = {
    elements: { url: { value: 'https://www.instagram.com/p/Example123/' } },
    querySelector() { return { disabled: false }; },
    addEventListener(type, callback) { listeners[`form:${type}`] = callback; }
  };
  const elements = Object.fromEntries(['status', 'result', 'places', 'notes', 'code', 'open-prototype',
    'title', 'summary', 'counts', 'raw'].map(id => [id, {
    textContent: '', hidden: false, value: id === 'code' ? 'private-test-code' : '',
    replaceChildren() {}, append() {}, addEventListener(type, callback) { listeners[`${id}:${type}`] = callback; }
  }]));
  const report = { post_id: 'ig_Example123', places: [], map_locations: [], ai_title: 'Test report' };
  const sent = [];
  const opened = { postMessage(value, origin) { sent.push({ value, origin }); } };
  const urls = [];
  const context = {
    document: { getElementById(id) { return id === 'form' ? form : elements[id]; } },
    window: {
      addEventListener(type, callback) { listeners[`window:${type}`] = callback; },
      open(url) { urls.push(url); return opened; }
    },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [report] }) })
  };
  const code = fs.readFileSync(path.join(__dirname, '../test-ui/app.js'), 'utf8');
  vm.runInNewContext(code, context);
  await listeners['form:submit']({ preventDefault() {} });
  listeners['open-prototype:click']();
  assert.deepEqual(urls, ['https://pinmap-prototype.vercel.app/index.html?mode=development&place-test=1']);
  listeners['window:message']({ origin: 'https://untrusted.example', source: opened,
    data: { type: 'pinmap:place-report-ready' } });
  listeners['window:message']({ origin: 'https://pinmap-prototype.vercel.app', source: {},
    data: { type: 'pinmap:place-report-ready' } });
  assert.equal(sent.length, 0);
  listeners['window:message']({ origin: 'https://pinmap-prototype.vercel.app', source: opened,
    data: { type: 'pinmap:place-report-ready' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, 'https://pinmap-prototype.vercel.app');
  assert.equal(sent[0].value.type, 'pinmap:place-report');
  assert.equal(sent[0].value.report.post_id, report.post_id);
  assert.equal(JSON.stringify({ urls, sent }).includes('private-test-code'), false);
  listeners['window:message']({ origin: 'https://pinmap-prototype.vercel.app', source: opened,
    data: { type: 'pinmap:place-report-imported' } });
  assert.equal(elements.status.textContent, '핀맵 지도에 분석 결과가 표시되었습니다.');
});

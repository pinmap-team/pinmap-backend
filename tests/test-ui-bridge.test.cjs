const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserWith(report) {
  const listeners = {};
  const timers = new Map();
  let nextTimer = 0;
  const form = {
    elements: { url: { value: 'https://www.instagram.com/p/Example123/' } },
    querySelector() { return { disabled: false }; },
    addEventListener(type, callback) { listeners[`form:${type}`] = callback; }
  };
  const elements = Object.fromEntries(['status', 'result', 'places', 'events', 'notes', 'code', 'open-prototype',
    'title', 'summary', 'counts', 'raw'].map(id => [id, {
    textContent: '', hidden: false, value: id === 'code' ? 'private-test-code' : '',
    children: [], replaceChildren() { this.children = []; }, append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, callback) { listeners[`${id}:${type}`] = callback; }
  }]));
  const sent = [];
  const opened = { postMessage(value, origin) { sent.push({ value, origin }); } };
  const urls = [];
  const requests = [];
  const context = {
    document: {
      getElementById(id) { return id === 'form' ? form : elements[id]; },
      createElement() { return { children: [], append(...nodes) { this.children.push(...nodes); }, textContent: '' }; }
    },
    window: {
      addEventListener(type, callback) { listeners[`window:${type}`] = callback; },
      open(url) { urls.push(url); return opened; }
    },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async (_url, options) => { requests.push(options); return { ok: true, status: 200, json: async () => ({ results: [report] }) }; },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const code = fs.readFileSync(path.join(__dirname, '../test-ui/app.js'), 'utf8');
  vm.runInNewContext(code, context);
  const reply = (type, origin = 'https://pinmap-prototype.vercel.app', source = opened, reason) => {
    listeners['window:message']({ origin, source, data: { type, reason } });
  };
  const expire = () => {
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    callback();
  };
  return { listeners, elements, sent, opened, urls, requests, timers, reply, expire };
}

test('the completed report reaches only the opened official prototype, without the test code', async () => {
  const report = { post_id: 'ig_Example123', places: [{ name: '한강 카페' }], map_locations: [], ai_title: 'Test report' };
  const { listeners, elements, sent, urls, timers, reply } = browserWith(report);
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(elements['open-prototype'].hidden, false);
  listeners['open-prototype:click']();
  assert.deepEqual(urls, ['https://pinmap-prototype.vercel.app/index.html?mode=development&place-test=1']);
  reply('pinmap:place-report-ready', 'https://untrusted.example');
  reply('pinmap:place-report-ready', undefined, {});
  assert.equal(sent.length, 0);
  reply('pinmap:place-report-ready');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, 'https://pinmap-prototype.vercel.app');
  assert.equal(sent[0].value.type, 'pinmap:place-report');
  assert.equal(sent[0].value.report.post_id, report.post_id);
  assert.equal(JSON.stringify({ urls, sent }).includes('private-test-code'), false);
  reply('pinmap:place-report-imported');
  assert.equal(elements.status.textContent, '핀맵 지도에 분석 결과가 표시되었습니다.');
  assert.equal(timers.size, 0);
});

test('an empty extraction cannot open an empty prototype map', async () => {
  const { listeners, elements, urls } = browserWith({ post_id: 'ig_empty', places: [], map_locations: [] });
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(elements.result.hidden, false);
  assert.equal(elements['open-prototype'].hidden, true);
  assert.match(elements.status.textContent, /추출한 장소나 일정이 없습니다/);
  listeners['open-prototype:click']();
  assert.equal(urls.length, 0);
});

test('event-only report shows dates and review notes without opening an empty map', async () => {
  const report = { post_id: 'ig_event', places: [], map_locations: [], content_kind: 'event', events: [{
    title: '봄 전시', event_type: 'exhibition', start_date: '2026-04-01', end_date: '2026-04-30',
    date_text: '4월', time_text: '11:00~18:00', venue_name: '전시장', address: null,
    needs_review: true, notes: ['운영시간 확인 필요']
  }] };
  const { listeners, elements, urls, requests } = browserWith(report);
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(elements['open-prototype'].hidden, true);
  assert.equal(elements.events.children.length, 1);
  assert.match(elements.events.children[0].children[1].textContent, /2026-04-01 ~ 2026-04-30/);
  assert.match(elements.events.children[0].children[2].textContent, /운영시간 확인 필요/);
  assert.match(elements.counts.textContent, /일정 1건/);
  assert.deepEqual(JSON.parse(requests[0].body).content_types, ['place', 'event']);
  listeners['open-prototype:click']();
  assert.equal(urls.length, 0);
});

test('failure acknowledgement and both transfer deadlines end the waiting state', async () => {
  const { listeners, elements, timers, reply, expire } = browserWith({
    post_id: 'ig_Example123', places: [{ name: '한강 카페' }], map_locations: []
  });
  await listeners['form:submit']({ preventDefault() {} });
  listeners['open-prototype:click']();
  expire();
  assert.match(elements.status.textContent, /연결 시간이 초과/);
  assert.equal(timers.size, 0);
  listeners['open-prototype:click']();
  reply('pinmap:place-report-ready');
  reply('pinmap:place-report-failed', undefined, undefined, '장소 데이터 형식 오류');
  assert.equal(elements.status.textContent, '핀맵 지도 표시 실패: 장소 데이터 형식 오류');
  assert.equal(timers.size, 0);
  listeners['open-prototype:click']();
  reply('pinmap:place-report-ready');
  expire();
  assert.match(elements.status.textContent, /표시 확인 시간이 초과/);
  assert.equal(timers.size, 0);
});

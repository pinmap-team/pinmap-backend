const form = document.getElementById('form');
const status = document.getElementById('status');
const result = document.getElementById('result');
const places = document.getElementById('places');
const notes = document.getElementById('notes');
const codeInput = document.getElementById('code');
const openPrototype = document.getElementById('open-prototype');
const PROTOTYPE_ORIGIN = 'https://pinmap-prototype.vercel.app';
let currentReport = null;
let prototypeWindow = null;
let awaitingPrototype = false;
let awaitingImport = false;
let transferTimer = null;
codeInput.value = sessionStorage.getItem('pinmap.place-test-code') || '';

function stopTransferTimer() {
  if (transferTimer !== null) clearTimeout(transferTimer);
  transferTimer = null;
}

function waitForTransfer(phase) {
  stopTransferTimer();
  transferTimer = setTimeout(() => {
    transferTimer = null;
    if (phase === 'ready' && awaitingPrototype) {
      awaitingPrototype = false;
      status.textContent = '핀맵 지도 연결 시간이 초과되었습니다. 다시 눌러 주세요.';
    } else if (phase === 'import' && awaitingImport) {
      awaitingImport = false;
      status.textContent = '핀맵 지도 표시 확인 시간이 초과되었습니다. 새 창을 확인하거나 다시 눌러 주세요.';
    }
  }, 30000);
}

window.addEventListener('message', event => {
  if (!currentReport || event.origin !== PROTOTYPE_ORIGIN || event.source !== prototypeWindow) return;
  if (event.data?.type === 'pinmap:place-report-imported' && awaitingImport) {
    awaitingImport = false;
    stopTransferTimer();
    status.textContent = '핀맵 지도에 분석 결과가 표시되었습니다.';
    return;
  }
  if (event.data?.type === 'pinmap:place-report-failed' && awaitingImport) {
    awaitingImport = false;
    stopTransferTimer();
    const reason = typeof event.data.reason === 'string' ? event.data.reason.trim().slice(0, 160) : '';
    status.textContent = reason ? `핀맵 지도 표시 실패: ${reason}` : '핀맵 지도에 결과를 표시하지 못했습니다. 다시 눌러 주세요.';
    return;
  }
  if (event.data?.type !== 'pinmap:place-report-ready' || !awaitingPrototype) return;
  awaitingPrototype = false;
  stopTransferTimer();
  try {
    prototypeWindow.postMessage({ type: 'pinmap:place-report', report: currentReport }, PROTOTYPE_ORIGIN);
    awaitingImport = true;
    status.textContent = '핀맵 지도로 분석 결과를 전송 중입니다.';
    waitForTransfer('import');
  } catch {
    status.textContent = '핀맵 지도에 결과를 전달하지 못했습니다. 다시 눌러 주세요.';
  }
});

openPrototype.addEventListener('click', () => {
  if (!Array.isArray(currentReport?.places) || !currentReport.places.length) return;
  stopTransferTimer();
  awaitingPrototype = false;
  awaitingImport = false;
  prototypeWindow = window.open(`${PROTOTYPE_ORIGIN}/index.html?mode=development&place-test=1`, '_blank');
  if (!prototypeWindow) {
    status.textContent = '새 창이 차단되었습니다. 팝업을 허용한 뒤 다시 눌러 주세요.';
    return;
  }
  awaitingPrototype = true;
  status.textContent = '핀맵 지도가 열리면 분석 결과를 전달합니다.';
  waitForTransfer('ready');
});

function placeRows(report) {
  return (report?.places || []).map(place => {
    const coordinates = place.coordinates;
    const located = Number.isFinite(coordinates?.lat) && Number.isFinite(coordinates?.lng);
    const status = place.map_lookup?.status;
    const reason = located ? '' : ({
      not_found: '지도에서 같은 이름의 장소를 찾지 못했습니다.',
      ambiguous: '동명이점 후보가 있어 위치를 확정하지 못했습니다.',
      lookup_failed: '지도 검색에 실패했습니다.'
    }[status] || (place.address ? '주소의 정확한 좌표를 확인하지 못했습니다.' : '주소를 확인하지 못했습니다.'));
    return { name: place.name || '이름 확인 필요', address: place.address || '', coordinates: located ? coordinates : null, reason };
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = '서버에서 게시물을 수집하고 장소를 분석 중입니다. 몇 분 걸릴 수 있습니다.';
  result.hidden = true;
  currentReport = null;
  stopTransferTimer();
  awaitingPrototype = false;
  awaitingImport = false;
  openPrototype.hidden = true;
  sessionStorage.setItem('pinmap.place-test-code', codeInput.value);
  try {
    const response = await fetch('/api/place-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pinmap-Test-Code': codeInput.value },
      body: JSON.stringify({ url: form.elements.url.value.trim() }),
      cache: 'no-store'
    });
    const data = await response.json();
    if (response.status === 401) {
      sessionStorage.removeItem('pinmap.place-test-code');
      throw new Error('테스트 코드를 확인해 주세요.');
    }
    if (!response.ok) throw new Error(data.error || data.message || `서버 오류 ${response.status}`);
    const report = data.results?.[0];
    if (!report) throw new Error('서버 응답에 게시물 결과가 없습니다.');
    currentReport = report;
    const rows = placeRows(report);
    places.replaceChildren();
    for (const row of rows) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = row.name;
      li.append(strong);
      const detail = document.createElement('small');
      detail.textContent = row.address || row.reason;
      li.append(detail);
      if (row.coordinates) {
        const link = document.createElement('a');
        const { lat, lng } = row.coordinates;
        link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `지도에서 보기 (${lat.toFixed(6)}, ${lng.toFixed(6)})`;
        li.append(link);
      }
      places.append(li);
    }
    notes.replaceChildren();
    for (const text of report.notes || []) {
      const li = document.createElement('li');
      li.textContent = String(text);
      notes.append(li);
    }
    document.getElementById('title').textContent = report.ai_title || '분석 결과';
    document.getElementById('summary').textContent = report.ai_summary || '';
    document.getElementById('counts').textContent = `추출 ${rows.length}곳 · 좌표 확인 ${rows.filter(row => row.coordinates).length}곳 · 확인 필요 ${rows.filter(row => !row.coordinates).length}곳`;
    document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
    status.textContent = rows.length ? '분석이 완료되었습니다.' : '분석은 끝났지만 추출한 장소가 없어 지도에 표시할 결과가 없습니다.';
    result.hidden = false;
    openPrototype.hidden = rows.length === 0;
  } catch (error) {
    status.textContent = error.message || '분석에 실패했습니다.';
  } finally {
    button.disabled = false;
  }
});

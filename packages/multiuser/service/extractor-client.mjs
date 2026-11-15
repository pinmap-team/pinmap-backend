import {AppError} from '../lib/errors.mjs';

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

function extractorUrl(pathname, env) {
  const origin = String(env.PINMAP_EXTRACTOR_ORIGIN || '').trim();
  const token = String(env.PINMAP_EXTRACTOR_TOKEN || '').trim();
  let url;
  try { url = new URL(origin); } catch { /* Checked below. */ }
  const loopback = url && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !loopback) || url.username || url.password || url.pathname !== '/' || !token) {
    throw new AppError('장소 추출 서버 연결을 확인하세요.', {code: 'extractor_config'});
  }
  url.pathname = pathname;
  return {url, token};
}

async function requestExtractor(pathname, payload, {env = process.env, fetcher = fetch, timeoutMs = 300000} = {}) {
  const {url, token} = extractorUrl(pathname, env);
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AppError('장소 추출 서버에 연결하지 못했습니다.', {code: 'extractor_unavailable'});
  }
  if (!response?.ok) {
    throw new AppError(response?.status === 401 ? '장소 추출 서버 인증을 확인하세요.' : '장소 추출 서버가 요청을 처리하지 못했습니다.', {
      code: response?.status === 401 ? 'extractor_auth' : 'extractor_failed',
    });
  }
  if (Number(response.headers?.get?.('content-length') || 0) > MAX_RESPONSE_BYTES) {
    throw new AppError('장소 추출 서버 응답이 너무 큽니다.', {code: 'extractor_response_limit'});
  }
  let body;
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('large response');
    body = JSON.parse(raw);
  } catch {
    throw new AppError('장소 추출 서버 응답을 읽지 못했습니다.', {code: 'extractor_response'});
  }
  return body;
}

export async function collectPublicLink(job, options = {}) {
  const body = await requestExtractor('/extract-link', {url: job.source_url, content_types: ['place', 'event']}, options);
  const report = body?.results?.[0];
  if (!report || typeof report !== 'object' ||
      (report.source_url && report.source_url !== job.source_url)) {
    throw new AppError('장소 추출 결과의 게시물 링크가 일치하지 않습니다.', {code: 'extractor_response'});
  }
  return report;
}

function relatedEvidence(ids, evidence) {
  const source = evidence.find(item => ids.includes(item.id));
  if (!source) return undefined;
  const item = {
    quote: String(source.text || '').slice(0, 1000),
    kind: String(source.kind || '').slice(0, 80),
  };
  if (source.source_file) item.file = String(source.source_file).slice(0, 180);
  if (Number.isFinite(source.time_seconds)) item.time_seconds = source.time_seconds;
  return item;
}

function placeRows(facts, evidence) {
  const names = facts.filter(fact => fact.field === 'place_name' && String(fact.value || '').trim());
  const addresses = facts.filter(fact => fact.field === 'address' && String(fact.value || '').trim());
  const usedAddresses = new Set();
  const rows = [];
  for (const fact of names) {
    const ids = Array.isArray(fact.evidence_ids) ? fact.evidence_ids.slice(0, 20) : [];
    const matching = addresses.filter(address => (address.evidence_ids || []).some(id => ids.includes(id)));
    const uniquelyRelated = matching.length === 1 && names.filter(name =>
      (name.evidence_ids || []).some(id => (matching[0].evidence_ids || []).includes(id))).length === 1;
    const address = uniquelyRelated ? matching[0] : null;
    if (address) usedAddresses.add(address);
    rows.push({name: String(fact.value).slice(0, 100), address: address ? String(address.value).slice(0, 300) : null,
      source: String(fact.source || 'analysis').slice(0, 80), evidence_ids: ids,
      evidence: relatedEvidence(ids, evidence)});
  }
  for (const fact of addresses) {
    if (usedAddresses.has(fact)) continue;
    const ids = Array.isArray(fact.evidence_ids) ? fact.evidence_ids.slice(0, 20) : [];
    rows.push({name: null, address: String(fact.value).slice(0, 300),
      source: String(fact.source || 'analysis').slice(0, 80), evidence_ids: ids,
      evidence: relatedEvidence(ids, evidence)});
  }
  const seen = new Set();
  return rows.filter(row => {
    const key = `${row.name || ''}\u0000${row.address || ''}`.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveMapLocations(_db, {facts = [], evidence = []}, options = {}) {
  const places = placeRows(facts, evidence);
  if (!places.length) return {locations: [], name_lookups: [], notes: []};
  const limit = 100;
  const notes = places.length > limit ? [`지도 검색은 한 게시물당 최대 ${limit}곳까지 처리합니다. 나머지 ${places.length - limit}곳은 확인이 필요합니다.`] : [];
  const resolved = [], mapLocations = [];
  for (let offset = 0; offset < Math.min(places.length, limit); offset += 20) {
    const batch = places.slice(offset, offset + 20);
    try {
      const body = await requestExtractor('/resolve-places', {places: batch}, options);
      if (!Array.isArray(body?.places) || !Array.isArray(body?.map_locations)) throw new Error('invalid map response');
      resolved.push(...body.places);
      mapLocations.push(...body.map_locations);
      if (Array.isArray(body.notes)) notes.push(...body.notes.filter(note => typeof note === 'string'));
    } catch {
      notes.push(`장소 ${offset + 1}~${offset + batch.length}곳의 지도 검색을 완료하지 못했습니다.`);
      resolved.push(...batch.filter(place => place.name).map(place => ({...place, map_lookup: {status: 'lookup_failed', candidates: []}})));
    }
  }
  const locations = mapLocations.map(location => ({
    ...location,
    source: location.name ? 'place_name' : 'address',
    provider: location.provider || location.coordinate_source,
    review_required: location.review_required !== false,
    evidence_ids: Array.isArray(location.evidence_ids) ? location.evidence_ids : [],
  }));
  const name_lookups = resolved.filter(place => place.name).map(place => ({
    place_name: place.name,
    evidence_ids: place.evidence_ids || [],
    status: place.map_lookup?.status || 'not_found',
    provider: place.map_lookup?.provider,
    candidates: place.map_lookup?.candidates || [],
  }));
  return {locations, name_lookups, notes};
}

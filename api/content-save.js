const Billing = require('../lib/billing');
const { extractionRequest, extractorConfig, forwardExtraction, instagramLink } = require('./place-extract');
const { getKey } = require('../config/keys.cjs');
const { supabaseConfig, bearerToken, authenticatedUser } = require('./content-extract');
const { randomUUID } = require('node:crypto');

const MAX_REQUEST_BYTES = 4096;
const MAX_CAPTURE_REQUEST_BYTES = 3 * 1024 * 1024;
const CAPTURE_URL = /^pinmap:\/\/capture\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_IMAGE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_DATABASE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_LENGTH = 410000;
const MAX_MAP_IMAGE_LENGTH = 125000;
const MAX_MAP_IMAGE_TOTAL = 500000;
const SELECT = 'id,user_id,source_url,content_kind,classification,status,ai_title,ai_summary,author_username,' +
  'author_profile_data_url,cover_data_url,places,events,map_locations,extraction_notes,' +
  'media_warnings,created_at,updated_at';

// The public key verifies the caller. Only this
// server holds the separate secret key used to write trusted analysis records.
function storageConfig(publicConfig, env = process.env) {
  const secret = getKey('SUPABASE_SECRET_KEY', env);
  return publicConfig && /^sb_secret_[A-Za-z0-9_-]{8,}$/.test(secret)
    ? { origin: publicConfig.origin, secret } : null;
}

function shortText(value, length) {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function optionalText(value, length) {
  return shortText(value, length) || null;
}

function safeNote(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  for (const name of ['PINMAP_EXTRACTOR_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'GOOGLE_PLACES_API_KEY', 'GOOGLE_MAPS_API_KEY']) {
    const secret = getKey(name);
    if (secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{8,})\b/g,
    '[redacted]').slice(0, 180);
}

function imageData(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength ||
      !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return value;
}

function coordinates(value) {
  const lat = value?.lat, lng = value?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function warning(code, message, name) {
  return { code, message, ...(name ? { name: shortText(name, 120) } : {}) };
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const seconds = value.time_seconds;
  return { kind: optionalText(value.kind, 40), quote: optionalText(value.quote, 180),
    file: optionalText(value.file, 100),
    time_seconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= 36000 ? seconds : null };
}

const CATEGORY_CATALOG = require('../categories.json');
function classification(value) {
  const category = CATEGORY_CATALOG.find(c=>c.id===value?.category || c.aliases.includes(value?.category));
  if (!value || value.source !== 'gemini_decisions' || value.status !== 'classified' ||
      value.model !== 'gemini-decision-1' || !category ||
      !['place','event','mixed','unknown'].includes(value.kind) ||
      !Number.isFinite(value.confidence) || value.confidence < .8 || value.confidence > 1) return {};
  return {source:value.source,status:value.status,model:value.model,kind:value.kind,
    category:category.id,label:category.label,confidence:value.confidence};
}

function sanitizeReport(report, sourceUrl, userId) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      !['extracted', 'needs_review', 'collection_failed', 'needs_media_or_ai',
        'extractor_unavailable', 'extractor_timeout', 'extractor_invalid_response'].includes(report.status)) return null;
  if (CAPTURE_URL.test(sourceUrl)) {
    if (report.source_url !== sourceUrl) return null;
  } else {
    try { if (instagramLink(report.source_url) !== sourceUrl) return null; }
    catch { return null; }
  }
  const warnings = [];
  const hasExtractedData = ['extracted', 'needs_review'].includes(report.status);
  const rawPlaces = hasExtractedData && Array.isArray(report.places) ? report.places : [];
  const rawEvents = hasExtractedData && Array.isArray(report.events) ? report.events : [];
  const rawLocations = hasExtractedData && Array.isArray(report.map_locations) ? report.map_locations : [];
  if (rawPlaces.length > 40) warnings.push(warning('places_truncated', '장소는 최대 40곳까지 저장했습니다.'));
  if (rawEvents.length > 40) warnings.push(warning('events_truncated', '행사는 최대 40개까지 저장했습니다.'));
  if (rawLocations.length > 40) warnings.push(warning('map_locations_truncated', '지도 위치는 최대 40곳까지 저장했습니다.'));

  const places = rawPlaces.slice(0, 40).filter(place => place && typeof place === 'object')
    .map(place => ({ name: optionalText(place.name, 120), address: optionalText(place.address, 240),
      area_hint: optionalText(place.area_hint, 100), source: optionalText(place.source, 40),
      coordinates: coordinates(place.coordinates), needs_review: place.needs_review !== false,
      map_lookup: { status: optionalText(place.map_lookup?.status, 40) },
      evidence: evidence(place.evidence) }));
  const events = rawEvents.slice(0, 40).filter(event => event && typeof event === 'object')
    .map(event => {
      const start = isoDate(event.start_date);
      let end = isoDate(event.end_date);
      const invalidDate = !!(event.start_date && !start) || !!(event.end_date && !end);
      const reversed = !!(start && end && end < start);
      if (reversed) end = null;
      const notes = Array.isArray(event.notes) ? event.notes.slice(0, 3).map(safeNote).filter(Boolean) : [];
      if (invalidDate || reversed) notes.push('날짜 형식 또는 순서를 확인해 주세요.');
      return { title: optionalText(event.title, 120),
        event_type: ['exhibition', 'pop_up', 'other'].includes(event.event_type) ? event.event_type : 'other',
        start_date: start, end_date: end, date_text: optionalText(event.date_text, 240),
        time_text: optionalText(event.time_text, 180), venue_name: optionalText(event.venue_name, 120),
        address: optionalText(event.address, 240), source: optionalText(event.source, 40),
        evidence: evidence(event.evidence), needs_review: event.needs_review !== false || invalidDate || reversed,
        notes };
    });

  let mapImageTotal = 0;
  const mapLocations = rawLocations.slice(0, 40).filter(location => location && typeof location === 'object')
    .flatMap(location => {
      const point = coordinates(location.coordinates);
      if (!point) {
        warnings.push(warning('invalid_map_location', '지도 좌표 형식이 잘못되어 위치를 저장하지 못했습니다.', location.name));
        return [];
      }
      let image = null;
      if (location.image_data_url) {
        const candidate = imageData(location.image_data_url, MAX_MAP_IMAGE_LENGTH);
        if (candidate && mapImageTotal + candidate.length <= MAX_MAP_IMAGE_TOTAL) {
          image = candidate;
          mapImageTotal += candidate.length;
        } else warnings.push(warning('place_image_omitted', '장소 사진 용량 제한으로 썸네일을 저장하지 못했습니다.', location.name));
      }
      return [{ name: optionalText(location.name, 120), address: optionalText(location.address, 240),
        coordinates: point, source: optionalText(location.source, 40),
        coordinate_source: optionalText(location.coordinate_source, 60),
        selection: optionalText(location.selection, 60), needs_review: location.needs_review !== false,
        image_data_url: image }];
    });

  const cover = imageData(report.cover_data_url, MAX_IMAGE_LENGTH);
  if (report.cover_data_url && !cover) warnings.push(warning('cover_omitted', '대표 이미지 용량 또는 형식 제한으로 저장하지 못했습니다.'));
  const profile = imageData(report.author_profile_data_url, MAX_IMAGE_LENGTH);
  if (report.author_profile_data_url && !profile) warnings.push(warning('profile_image_omitted', '작성자 사진 용량 또는 형식 제한으로 저장하지 못했습니다.'));
  const contentKind = places.length && events.length ? 'mixed' : places.length ? 'place' :
    events.length ? 'event' : 'unknown';
  const hasSummary = !!optionalText(report.ai_title, 160) && !!optionalText(report.ai_summary, 800);
  const status = contentKind === 'unknown' && ['extracted', 'needs_review'].includes(report.status) && !hasSummary
    ? 'needs_media_or_ai' : report.status;
  return { user_id: userId, source_url: sourceUrl, content_kind: contentKind,
    classification: classification(report.classification),
    status, ai_title: optionalText(report.ai_title, 160),
    ai_summary: optionalText(report.ai_summary, 800),
    author_username: optionalText(report.author_username, 64),
    author_profile_data_url: profile, cover_data_url: cover,
    places, events, map_locations: mapLocations,
    extraction_notes: Array.isArray(report.notes)
      ? report.notes.slice(0, 12).map(safeNote).filter(Boolean) : [],
    media_warnings: warnings.sort((a, b) => Number(['cover_omitted', 'profile_image_omitted'].includes(b.code)) -
      Number(['cover_omitted', 'profile_image_omitted'].includes(a.code))).slice(0, 40),
    updated_at: new Date().toISOString() };
}

async function limitedJson(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_DATABASE_RESPONSE_BYTES) throw Error('response_too_large');
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_DATABASE_RESPONSE_BYTES) throw Error('response_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_DATABASE_RESPONSE_BYTES) throw Error('response_too_large');
  return JSON.parse(raw);
}

function dataHeaders(config, extra = {}) {
  return { apikey: config.secret, Accept: 'application/json', ...extra };
}

async function existingContent(config, userId, sourceUrl, fetcher = fetch, optional = false) {
  const url = new URL('/rest/v1/pinmap_saved_content', config.origin);
  url.searchParams.set('select', SELECT);
  url.searchParams.set('user_id', `eq.${userId}`);
  url.searchParams.set('source_url', `eq.${sourceUrl}`);
  url.searchParams.set('limit', '1');
  const response = await fetcher(url, {
    headers: dataHeaders(config), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw Error('storage_unavailable');
  const items = await limitedJson(response);
  if (optional && Array.isArray(items) && items.length === 0) return null;
  if (!Array.isArray(items) || items.length !== 1 || items[0]?.user_id !== userId ||
      items[0]?.source_url !== sourceUrl) throw Error('invalid_storage_response');
  return items[0];
}

async function upsertContent(config, row, fetcher = fetch) {
  try {
    if (row.content_kind === 'unknown' && row.status === 'extracted') {
      const previous = await existingContent(config, row.user_id, row.source_url, fetcher, true);
      if (previous && previous.content_kind !== 'unknown') return { status: 200, item: previous };
    }
    const url = new URL('/rest/v1/pinmap_saved_content', config.origin);
    url.searchParams.set('on_conflict', 'user_id,source_url');
    url.searchParams.set('select', SELECT);
    const response = await fetcher(url, {
      method: 'POST',
      headers: dataHeaders(config, {
        'Content-Type': 'application/json',
        Prefer: `resolution=${row.content_kind === 'unknown' && row.status !== 'extracted' ? 'ignore-duplicates' : 'merge-duplicates'},return=representation` }),
      body: JSON.stringify(row), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      let code;
      try { code = (await limitedJson(response)).code; } catch {}
      return code === 'PZ001' ? { status: 409, error: 'saved_content_limit' } :
        { status: 503, error: 'storage_unavailable' };
    }
    const records = await limitedJson(response);
    if (!Array.isArray(records) || records.length > 1) throw Error('invalid_storage_response');
    const item = records[0] || (row.content_kind === 'unknown' && row.status !== 'extracted'
      ? await existingContent(config, row.user_id, row.source_url, fetcher) : null);
    if (item?.source_url !== row.source_url || item?.user_id !== row.user_id) throw Error('invalid_storage_response');
    return { status: 200, item };
  } catch { return { status: 503, error: 'storage_unavailable' }; }
}

function listQuery(req) {
  const query = req.query || {};
  const limit = query.limit === undefined ? 2 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return null;
  return { limit, offset };
}

async function listContent(config, userId, query, fetcher = fetch) {
  try {
    const url = new URL('/rest/v1/pinmap_saved_content', config.origin);
    url.searchParams.set('select', SELECT);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('order', 'updated_at.desc,id.desc');
    url.searchParams.set('limit', String(query.limit));
    url.searchParams.set('offset', String(query.offset));
    const response = await fetcher(url, {
      headers: dataHeaders(config), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { status: 503, error: 'storage_unavailable' };
    const items = await limitedJson(response);
    if (!Array.isArray(items) || items.length > query.limit ||
        items.some(item => item?.user_id !== userId)) throw Error('invalid_storage_response');
    return { status: 200, items,
      next_offset: items.length === query.limit ? query.offset + query.limit : null };
  } catch { return { status: 503, error: 'storage_unavailable' }; }
}

async function deleteContent(config, userId, sourceUrl, fetcher = fetch) {
  try {
    const url = new URL('/rest/v1/pinmap_saved_content', config.origin);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('source_url', `eq.${sourceUrl}`);
    url.searchParams.set('select', 'id,user_id,source_url');
    const response = await fetcher(url, {
      method: 'DELETE',
      headers: dataHeaders(config, { Prefer: 'return=representation' }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { status: 503, error: 'storage_unavailable' };
    const rows = await limitedJson(response);
    if (!Array.isArray(rows) || rows.length > 1 ||
        rows.some(row => row?.user_id !== userId || row?.source_url !== sourceUrl)) throw Error('invalid_storage_response');
    return { status: 200, deleted: rows.length === 1 };
  } catch { return { status: 503, error: 'storage_unavailable' }; }
}

async function storageReady(config, userId, fetcher = fetch) {
  try {
    const url = new URL('/rest/v1/pinmap_saved_content', config.origin);
    url.searchParams.set('select', 'id');
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('limit', '0');
    const response = await fetcher(url, {
      headers: dataHeaders(config), signal: AbortSignal.timeout(8000)
    });
    return response.ok;
  } catch { return false; }
}

module.exports = async function contentSave(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Authorization');
  if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const config = supabaseConfig();
  const storage = storageConfig(config);
  if (!storage) return res.status(503).json({ error: 'content_storage_not_configured' });
  let payload, query;
  if (req.method === 'POST' || req.method === 'DELETE') {
    const declared = Number(req.headers?.['content-length'] || 0);
    let bytes;
    try { bytes = Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})); }
    catch { return res.status(400).json({ error: 'invalid_request' }); }
    if (declared > MAX_CAPTURE_REQUEST_BYTES || bytes > MAX_CAPTURE_REQUEST_BYTES)
      return res.status(413).json({ error: 'request_too_large' });
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const capture = req.method === 'POST' && body?.capture_image !== undefined;
      if (bytes > (capture ? MAX_CAPTURE_REQUEST_BYTES : MAX_REQUEST_BYTES))
        return res.status(413).json({ error: 'request_too_large' });
      const allowed = capture ? ['capture_image', 'capture_id'] : req.method === 'POST' ? ['url', 'content_types'] : ['url'];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw Error('unexpected_field');
      if (capture) {
        if (!CAPTURE_IMAGE.test(body.capture_image) || body.capture_image.length > 2800000 ||
            (body.capture_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.capture_id)))
          throw Error('invalid_capture');
        payload = {url:'pinmap://capture/' + (body.capture_id || randomUUID()),
          image_data_url:body.capture_image,content_types:['place','event']};
      } else if (req.method === 'DELETE' && CAPTURE_URL.test(body.url)) payload = {url:body.url};
      else payload = extractionRequest(body, ['place', 'event']);
    } catch { return res.status(400).json({ error: 'invalid_request' }); }
  } else {
    query = listQuery(req);
    if (!query) return res.status(400).json({ error: 'invalid_pagination' });
  }
  const token = bearerToken(req.headers?.authorization);
  if (!token) return res.status(401).json({ error: 'authentication_required' });
  const auth = await authenticatedUser(config, token);
  if (auth.status !== 200) return res.status(auth.status).json({
    error: auth.status === 503 ? 'auth_unavailable' : 'authentication_required' });
  if (req.method === 'GET') {
    const listed = await listContent(storage, auth.userId, query);
    return res.status(listed.status).json(listed.status === 200
      ? { items: listed.items, next_offset: listed.next_offset } : { error: listed.error });
  }
  if (req.method === 'DELETE') {
    const removed = await deleteContent(storage, auth.userId, payload.url);
    return res.status(removed.status).json(removed.status === 200
      ? { deleted: removed.deleted } : { error: removed.error });
  }
  if (!await storageReady(storage, auth.userId)) {
    return res.status(503).json({ error: 'storage_unavailable' });
  }
  if (!extractorConfig()) return res.status(503).json({ error: 'content_extraction_not_configured' });
  let reservation;
  try { reservation=await Billing.reserve(auth.userId); }
  catch(error){return res.status(error.status||503).json({error:error.status?error.message:'billing_unavailable'});}
  let forwarded;
  try { forwarded = await forwardExtraction(payload, { timeoutMs: 245000,
    path: payload.image_data_url ? '/extract-capture' : '/extract-link' }); }
  catch {await Billing.finish(reservation,false);return res.status(503).json({error:'extractor_unavailable'});}

  const result = forwarded.status === 200 && Array.isArray(forwarded.body.results) &&
    forwarded.body.results.length === 1 ? forwarded.body.results[0] : null;
  let row = result && sanitizeReport(result, payload.url, auth.userId);
  if (payload.image_data_url && !row) {
    await Billing.finish(reservation, false);
    return res.status(forwarded.status === 504 ? 504 : 502).json({error:'capture_analysis_failed'});
  }
  if (!row) {
    const status = forwarded.status === 504 ? 'extractor_timeout' :
      forwarded.status === 200 ? 'extractor_invalid_response' : 'extractor_unavailable';
    row = sanitizeReport({ source_url: payload.url, status, notes: [
      status === 'extractor_timeout' ? '게시물 분석 시간이 초과되어 링크만 저장했습니다.' :
        status === 'extractor_invalid_response' ? '게시물 분석 결과의 형식이 잘못되어 링크만 저장했습니다.' :
          '게시물 분석 서버가 응답하지 않아 링크만 저장했습니다.'
    ] }, payload.url, auth.userId);
  }
  const saved = await upsertContent(storage, row);
  await Billing.finish(reservation, saved.status===200 && ['extracted','needs_review'].includes(row.status) && !!row.ai_summary);
  if (saved.status !== 200) return res.status(saved.status).json({ error: saved.error });
  return res.status(200).json({ item: saved.item, analysis_status: row.status,
    analysis_notes: row.extraction_notes, warnings: row.media_warnings });
};

module.exports.sanitizeReport = sanitizeReport;
module.exports.storageConfig = storageConfig;
module.exports.listQuery = listQuery;
module.exports.upsertContent = upsertContent;
module.exports.listContent = listContent;
module.exports.deleteContent = deleteContent;
module.exports.storageReady = storageReady;

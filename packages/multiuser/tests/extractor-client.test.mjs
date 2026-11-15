import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPublicLink, resolveMapLocations} from '../service/extractor-client.mjs';

const env = {PINMAP_EXTRACTOR_ORIGIN: 'https://extractor.example.test', PINMAP_EXTRACTOR_TOKEN: 'private-token'};

test('public links use the shared extractor and keep its token server-side', async () => {
  const url = 'https://www.instagram.com/p/example/';
  let calls = 0;
  const report = await collectPublicLink({source_url: url}, {env, fetcher: async (target, init) => {
    calls++;
    assert.equal(target.href, 'https://extractor.example.test/extract-link');
    assert.equal(init.headers.Authorization, 'Bearer private-token');
    assert.deepEqual(JSON.parse(init.body), {url});
    return Response.json({results: [{source_url: url, status: 'extracted', places: [], map_locations: []}]});
  }});
  assert.equal(calls, 1);
  assert.equal(report.status, 'extracted');
  await assert.rejects(collectPublicLink({source_url: url}, {env, fetcher: async () =>
    Response.json({results: [{source_url: 'https://www.instagram.com/p/other/'}]})}),
  error => error.code === 'extractor_response' && !error.message.includes('private-token'));
});

test('uploaded-media place facts resolve through the shared map endpoint once', async () => {
  let calls = 0;
  const result = await resolveMapLocations(null, {
    facts: [
      {field: 'place_name', value: '테스트 카페', evidence_ids: ['caption']},
      {field: 'address', value: '서울 마포구 양화로 1', evidence_ids: ['caption']},
    ],
    evidence: [{id: 'caption', kind: 'caption', text: '테스트 카페, 서울 마포구 양화로 1'}],
  }, {env, fetcher: async (target, init) => {
    calls++;
    assert.equal(target.pathname, '/resolve-places');
    const body = JSON.parse(init.body);
    assert.equal(body.places.length, 1);
    assert.equal(body.places[0].name, '테스트 카페');
    assert.equal(body.places[0].address, '서울 마포구 양화로 1');
    return Response.json({places: [{name: '테스트 카페', evidence_ids: ['caption'],
      map_lookup: {status: 'matched', provider: 'google_places', candidates: []}}],
    map_locations: [{name: '테스트 카페', address: '서울 마포구 양화로 1',
      coordinates: {lat: 37.55, lng: 126.91}, provider: 'google_places', evidence_ids: ['caption']} ]});
  }});
  assert.equal(calls, 1);
  assert.equal(result.locations[0].source, 'place_name');
  assert.equal(result.locations[0].coordinates.lat, 37.55);
  assert.equal(result.name_lookups[0].status, 'matched');
});

test('empty or unavailable map lookup is explicit and does not leak credentials', async () => {
  const unused = () => {throw new Error('network must not be called');};
  assert.deepEqual(await resolveMapLocations(null, {facts: [], evidence: []}, {fetcher: unused}),
    {locations: [], name_lookups: [], notes: []});
  const failed = await resolveMapLocations(null, {facts: [{field: 'place_name', value: '테스트 카페'}]},
    {env, fetcher: async () => Response.json({error: 'bad token'}, {status: 401})});
  assert.equal(failed.locations.length, 0);
  assert.equal(failed.name_lookups[0].status, 'lookup_failed');
  assert.ok(failed.notes[0].includes('지도 검색'));
  assert.ok(!JSON.stringify(failed).includes('private-token'));
});

test('more than twenty places are checked in batches without silent omission', async () => {
  let calls = 0;
  const facts = Array.from({length: 21}, (_, index) => ({field: 'place_name', value: `장소 ${index + 1}`}));
  const result = await resolveMapLocations(null, {facts}, {env, fetcher: async (_target, init) => {
    calls++;
    const places = JSON.parse(init.body).places;
    assert.ok(places.length <= 20);
    return Response.json({places, map_locations: []});
  }});
  assert.equal(calls, 2);
  assert.equal(result.name_lookups.length, 21);
  assert.deepEqual(result.notes, []);
});

test('one caption address is not assigned to multiple venue names', async () => {
  await resolveMapLocations(null, {facts: [
    {field: 'place_name', value: '첫 장소', evidence_ids: ['caption']},
    {field: 'place_name', value: '둘째 장소', evidence_ids: ['caption']},
    {field: 'address', value: '서울 마포구 양화로 1', evidence_ids: ['caption']},
  ], evidence: [{id: 'caption', kind: 'caption', text: '첫 장소와 둘째 장소, 서울 마포구 양화로 1'}]},
  {env, fetcher: async (_target, init) => {
    const rows = JSON.parse(init.body).places;
    assert.equal(rows.length, 3);
    assert.ok(rows.filter(row => row.name).every(row => row.address === null));
    assert.equal(rows.filter(row => row.address).length, 1);
    return Response.json({places: [], map_locations: []});
  }});
});

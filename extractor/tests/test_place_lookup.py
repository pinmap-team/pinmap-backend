import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from place_server import lookup_place_address, resolve_missing_addresses, geocode_address, extract_one, ocr_named_places, request_json_with_retry, ai_extract, ai_post_summary, ai_match_location_images, dedupe, compatible_place_addresses, valid_world_point


class PlaceLookupTests(unittest.TestCase):
    def test_openai_matches_named_place_to_source_image(self):
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'link-slide-01.jpg'
            source.write_bytes(b'image')
            def thumbnail(command, **_):
                Path(command[-1]).write_bytes(b'thumbnail')
                return SimpleNamespace(returncode=0)
            output={'status':'completed','output':[{'content':[{'type':'output_text',
                'text':json.dumps({'matches':[{'name':'서울숲','file':source.name}]})}]}]}
            settings={'MULTIUSER_AI_PROVIDER':'openai','OPENAI_API_KEY':'test-key',
                      'PINMAP_PLACE_AI_MODEL':'gpt-4.1-mini'}
            with patch('place_server.ai_settings',return_value=settings), \
                 patch('place_server.subprocess.run',side_effect=thumbnail), \
                 patch('place_server.request_json_with_retry',return_value=output) as send:
                matches=ai_match_location_images([{'name':'서울숲'}],[source],'ffmpeg')
            self.assertEqual(matches,{'서울숲':source.name})
            request=send.call_args.args[0]
            self.assertEqual(request.full_url,'https://api.openai.com/v1/responses')
            body=json.loads(request.data)
            self.assertEqual(body['model'],'gpt-4.1-mini')
            self.assertFalse(body['store'])
            self.assertTrue(any(part['type']=='input_image' for part in body['input'][0]['content']))

    def test_invalid_numeric_coordinates_cannot_become_map_pins(self):
        self.assertFalse(valid_world_point({'lat': float('nan'), 'lng': 126.9}))
        self.assertFalse(valid_world_point({'lat': True, 'lng': 126.9}))
        self.assertFalse(valid_world_point({'lat': 37.5, 'lng': float('inf')}))

    def test_ai_post_summary_returns_grounded_title_and_detail(self):
        output = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [
            {'text': '{"title":"서울 찜질방 11곳", "summary":"서울 여러 지역의 찜질방에서 따뜻한 탕과 휴식 공간을 소개해요. 게시물은 각 장소의 분위기와 이용할 수 있는 공간을 보여줘요. 방문 전에 장소별 정보를 확인할 수 있어요."}'}]}}]}
        with patch('place_server.ai_settings', return_value={
                'MULTIUSER_AI_PROVIDER': 'gemini', 'MULTIUSER_MODEL': 'gemini-2.5-flash',
                'GEMINI_API_KEY': 'test-key'}), \
             patch('place_server.request_json_with_retry', return_value=output) as request:
            title, summary, error = ai_post_summary('서울 찜질방 추천', [], [{'name': '테스트 스파'}])
        self.assertEqual(title, '서울 찜질방')
        self.assertIn('휴식 공간', summary)
        self.assertIn('방문 전에', summary)
        self.assertGreater(len(summary), 80)
        self.assertIsNone(error)
        payload = json.loads(request.call_args.args[0].data)
        self.assertIn('서울 찜질방 추천', payload['contents'][0]['parts'][0]['text'])
        self.assertIn('3~4문장', payload['contents'][0]['parts'][0]['text'])

    def test_content_description_uses_image_and_audio_evidence(self):
        output = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [
            {'text': '{"title":"전시 산책", "summary":"전시 공간과 작품을 소개해요. 영상에는 작품을 둘러보는 장면이 이어져요. 음성에서는 관람 동선을 설명해요."}'}]}}]}
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'slide.png'
            image.write_bytes(b'\x89PNG\r\n\x1a\nimage')
            with patch('place_server.ai_settings', return_value={
                    'MULTIUSER_AI_PROVIDER': 'gemini', 'MULTIUSER_MODEL': 'gemini-2.5-flash',
                    'GEMINI_API_KEY': 'test-key'}), \
                 patch('place_server.request_json_with_retry', return_value=output) as request:
                _, description, error = ai_post_summary('', [], [], images=[
                    {'path': str(image), 'source_file': 'slide.png', 'time_seconds': None}], transcripts=[
                    {'source_file': 'clip.mp4', 'time_seconds': 4.2,
                     'text': '관람 동선을 따라 전시를 둘러봅니다.'}])
        self.assertIsNone(error)
        self.assertIn('관람 동선', description)
        payload = json.loads(request.call_args.args[0].data)
        parts = payload['contents'][0]['parts']
        self.assertIn('관람 동선을 따라', parts[0]['text'])
        self.assertTrue(any('inline_data' in part for part in parts))
        self.assertEqual(payload['generationConfig']['maxOutputTokens'], 800)

    def test_long_ai_summary_ends_at_sentence_boundary(self):
        first = '서울 여러 지역의 찜질방에서 탕과 휴식 공간을 즐길 수 있어요.'
        output = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [
            {'text': json.dumps({'title': '서울 찜질방', 'summary': first + ' ' + '추가 설명을 여러 번 반복합니다. ' * 30}, ensure_ascii=False)}]}}]}
        with patch('place_server.ai_settings', return_value={
                'MULTIUSER_AI_PROVIDER': 'gemini', 'MULTIUSER_MODEL': 'gemini-2.5-flash',
                'GEMINI_API_KEY': 'test-key'}), \
             patch('place_server.request_json_with_retry', return_value=output):
            _, summary, error = ai_post_summary('', [], [])
        self.assertTrue(summary.startswith(first))
        self.assertIn('추가 설명', summary)
        self.assertLessEqual(len(summary), 500)
        self.assertTrue(summary.endswith('합니다.'))
        self.assertIsNone(error)

    def test_equivalent_address_format_keeps_google_place_coordinates(self):
        places = [{'name': '건영스파밸리', 'address': '서울 노원구 섬밭로 258 건영백화점 7층'}]
        lookup = {'status': 'matched', 'provider': 'google_places', 'candidates': [
            {'name': '건영스파밸리', 'address': '서울특별시 노원구 섬밭로 258',
             'coordinates': {'lat': 37.6388263, 'lng': 127.0647546}}]}
        with patch('place_server.lookup_place_address', return_value=lookup), \
             patch('place_server.geocode_address') as geocode:
            self.assertEqual(resolve_missing_addresses(places), [])
        self.assertEqual(places[0]['coordinates'], {'lat': 37.6388263, 'lng': 127.0647546})
        geocode.assert_not_called()

    def test_address_matching_rejects_other_city_or_building(self):
        self.assertFalse(compatible_place_addresses('서울 성동구 성수동2가 277-17',
                                                    '경기도 안산시 상록구 본오3동 874'))
        self.assertFalse(compatible_place_addresses('서울 노원구 섬밭로 258',
                                                    '서울 노원구 섬밭로 260'))
        self.assertFalse(compatible_place_addresses('서울 강남구 대치동 890-59',
                                                    '서울 강남구 대치동 890-60'))
        self.assertTrue(compatible_place_addresses('서울 강남구 대치동 890-59',
                                                   '서울특별시 강남구 선릉로86길 31 롯데골드로즈2 B1'))

    def test_gemini_invalid_key_error_is_actionable(self):
        body = json.dumps({'error': {'message': 'API key not valid. Please pass a valid API key.',
                                     'details': [{'reason': 'API_KEY_INVALID'}]}}).encode()
        failure = urllib.error.HTTPError('https://example.invalid', 400, 'Bad Request', {}, io.BytesIO(body))
        with patch('place_server.ai_settings', return_value={'MULTIUSER_AI_PROVIDER': 'gemini',
                                                             'MULTIUSER_MODEL': 'gemini-2.5-flash',
                                                             'GEMINI_API_KEY': 'test'}), \
             patch('place_server.request_json_with_retry', side_effect=failure):
            places, error = ai_extract('', [], [], [])
        self.assertEqual(places, [])
        self.assertIn('GEMINI_API_KEY가 Google에서 유효하지 않다고', error)

    def test_naver_unique_exact_name_supplies_reviewable_address(self):
        def opener(request, timeout):
            self.assertIn('openapi.naver.com', request.full_url)
            return io.BytesIO(json.dumps({'total': 1, 'items': [
                {'title': '<b>테스트 카페</b>', 'roadAddress': '서울특별시 종로구 세종대로 1'}
            ]}).encode())

        result = lookup_place_address('테스트 카페', {'NAVER_CLIENT_ID': 'id',
                                                    'NAVER_CLIENT_SECRET': 'secret'}, opener)
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['address'], '서울특별시 종로구 세종대로 1')

    def test_official_search_uses_post_area_without_changing_exact_name_check(self):
        def opener(request, timeout):
            self.assertIn('%ED%95%A9%EC%A0%95', request.full_url)
            return io.BytesIO(json.dumps({'total': 1, 'items': [
                {'title': '테스트 카페', 'roadAddress': '서울 마포구 양화로 1',
                 'mapx': '1269873882', 'mapy': '375666103'}]}).encode())
        result = lookup_place_address('테스트 카페', {'NAVER_CLIENT_ID': 'id',
                                                    'NAVER_CLIENT_SECRET': 'secret'}, opener, area_hint='합정')
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['candidates'][0]['coordinates'], {'lat': 37.5666103, 'lng': 126.9873882})

    def test_google_multiple_exact_names_remain_ambiguous(self):
        def opener(request, timeout):
            self.assertIn('places.googleapis.com', request.full_url)
            return io.BytesIO(json.dumps({'places': [
                {'displayName': {'text': '테스트 카페'}, 'formattedAddress': '서울시 종로구 1'},
                {'displayName': {'text': '테스트 카페'}, 'formattedAddress': '서울시 강남구 2'}
            ]}).encode())

        result = lookup_place_address('테스트 카페', {'GOOGLE_MAPS_API_KEY': 'test-key'}, opener)
        self.assertEqual(result['status'], 'ambiguous')
        self.assertEqual(len(result['candidates']), 2)

    def test_empty_naver_search_falls_back_to_google_without_guessing_name(self):
        called = []
        def opener(request, timeout):
            called.append(request.full_url)
            if 'openapi.naver.com' in request.full_url:
                return io.BytesIO(json.dumps({'total': 0, 'items': []}).encode())
            self.assertIn('places.googleapis.com', request.full_url)
            return io.BytesIO(json.dumps({'places': [
                {'displayName': {'text': '다른 카페'}, 'formattedAddress': '서울 마포구 양화로 1'},
                {'displayName': {'text': '테스트 카페'}, 'formattedAddress': '서울 마포구 양화로 2',
                 'location': {'latitude': 37.55, 'longitude': 126.91}}
            ]}).encode())
        result = lookup_place_address('테스트 카페', {'NAVER_CLIENT_ID': 'id',
            'NAVER_CLIENT_SECRET': 'secret', 'GOOGLE_MAPS_API_KEY': 'key'}, opener)
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['provider'], 'google_places')
        self.assertEqual(result['candidates'][0]['name'], '테스트 카페')
        self.assertEqual(result['providers_tried'], ['naver_local_search', 'google_places'])
        self.assertEqual(len(called), 2)

    def test_malformed_naver_results_fall_back_to_valid_google_result(self):
        def opener(request, timeout):
            if 'openapi.naver.com' in request.full_url:
                return io.BytesIO(b'{"items": {"unexpected": "shape"}}')
            return io.BytesIO(json.dumps({'places': [{
                'displayName': {'text': '테스트 카페'},
                'formattedAddress': '서울 마포구 양화로 2',
                'location': {'latitude': 37.55, 'longitude': 126.91}}]}).encode())
        result = lookup_place_address('테스트 카페', {'NAVER_CLIENT_ID': 'id',
            'NAVER_CLIENT_SECRET': 'secret', 'GOOGLE_MAPS_API_KEY': 'key'}, opener)
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['provider'], 'google_places')
        self.assertEqual(result['providers_tried'], ['naver_local_search', 'google_places'])

    def test_malformed_google_candidate_fields_do_not_crash_lookup(self):
        def opener(request, timeout):
            if 'places.googleapis.com' in request.full_url:
                return io.BytesIO(json.dumps({'places': [
                    {'displayName': {'text': '테스트 카페'}, 'formattedAddress': {'bad': 'value'}}
                ]}).encode())
            return io.BytesIO(json.dumps({'features': [None, {
                'properties': {'countrycode': 'KR', 'name': '테스트 카페', 'state': '서울'},
                'geometry': {'coordinates': [126.91, 37.55]}}]}).encode())
        result = lookup_place_address('테스트 카페', {'GOOGLE_MAPS_API_KEY': 'key'}, opener)
        self.assertEqual(result['provider'], 'photon_openstreetmap')
        self.assertEqual(result['status'], 'matched')

    def test_google_empty_search_can_use_exact_korean_photon_candidate(self):
        def opener(request, timeout):
            if 'places.googleapis.com' in request.full_url:
                return io.BytesIO(json.dumps({'places': []}).encode())
            self.assertIn('photon.komoot.io', request.full_url)
            return io.BytesIO(json.dumps({'features': [
                {'properties': {'countrycode': 'KR', 'name': '테스트 카페', 'state': '서울'},
                 'geometry': {'coordinates': [126.91, 37.55]}},
                {'properties': {'countrycode': 'KR', 'name': '다른 카페', 'state': '서울'},
                 'geometry': {'coordinates': [126.92, 37.56]}}
            ]}).encode())
        result = lookup_place_address('테스트 카페', {'GOOGLE_MAPS_API_KEY': 'key'}, opener)
        self.assertEqual(result['provider'], 'photon_openstreetmap')
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(len(result['candidates']), 1)

    def test_google_search_combines_name_area_and_venue_keyword(self):
        def opener(request, timeout):
            query = json.loads(request.data)['textQuery']
            self.assertEqual(query, '엘리먼츠 압구정로데오 칵테일 바')
            return io.BytesIO(json.dumps({'places': [{
                'displayName': {'text': '바 엘리먼츠'},
                'formattedAddress': '서울 강남구 압구정로 1',
                'location': {'latitude': 37.53, 'longitude': 127.03}}]}).encode())
        result = lookup_place_address('엘리먼츠', {'GOOGLE_MAPS_API_KEY': 'test-key'}, opener,
                                      area_hint='압구정로데오', search_keyword='칵테일 바')
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['candidates'][0]['coordinates'], {'lat': 37.53, 'lng': 127.03})

    def test_google_retries_without_keyword_when_scoped_query_hides_venue(self):
        queries = []
        def opener(request, timeout):
            query = json.loads(request.data)['textQuery']
            queries.append(query)
            places = [] if len(queries) == 1 else [{'displayName': {'text': '발아'},
                                                    'formattedAddress': '서울 마포구 양화로1길 18'}]
            return io.BytesIO(json.dumps({'places': places}).encode())
        result = lookup_place_address('발아', {'GOOGLE_MAPS_API_KEY': 'test-key'}, opener,
                                      area_hint='합정', search_keyword='칵테일 바')
        self.assertEqual(queries, ['발아 합정 칵테일 바', '발아 합정'])
        self.assertEqual(result['status'], 'matched')

    def test_name_only_fallback_does_not_pin_different_area(self):
        places = [{'name': '아포텍', 'address': None, 'area_hint': '해방존',
                   'source': 'media_ocr', 'needs_review': True}]
        lookup = {'status': 'matched', 'provider': 'google_places', 'name_only_fallback': True,
                  'candidates': [{'name': '아포텍', 'address': '경기도 시흥시 정왕동 1269-13',
                                  'coordinates': {'lat': 37.338, 'lng': 126.732}}]}
        with patch('place_server.lookup_place_address', return_value=lookup):
            notes = resolve_missing_addresses(places)
        self.assertIsNone(places[0]['address'])
        self.assertNotIn('coordinates', places[0])
        self.assertIn('지역 단서와 맞지 않는', ' '.join(notes))

    def test_ocr_and_ai_variants_on_same_slide_are_one_place(self):
        places = [{'name': 'WEEKEND CHICKEN CLUB & BAR', 'address': None,
                   'source': 'media_ocr', 'evidence': {'file': 'slide-11.jpg'}},
                  {'name': 'Weekend Chicken Club', 'address': None,
                   'source': 'ai_api', 'evidence': {'file': 'slide-11.jpg'}}]
        self.assertEqual(len(dedupe(places)), 1)

    def test_google_foreign_place_can_supply_map_coordinate(self):
        places = [{'name': 'Weekend Chicken Club', 'address': None, 'area_hint': '타이페이',
                   'source': 'media_ocr', 'needs_review': True}]
        lookup = {'status': 'matched', 'provider': 'google_places', 'candidates': [
            {'name': 'Weekend Chicken Club', 'address': 'Taipei City, 대만',
             'coordinates': {'lat': 25.033, 'lng': 121.565}}]}
        with patch('place_server.lookup_place_address', return_value=lookup):
            resolve_missing_addresses(places)
        self.assertEqual(places[0]['coordinates'], {'lat': 25.033, 'lng': 121.565})

    def test_photon_fallback_uses_exact_name_and_korean_coordinates(self):
        def opener(request, timeout):
            self.assertIn('photon.komoot.io', request.full_url)
            return io.BytesIO(json.dumps({'features': [
                {'properties': {'countrycode': 'KR', 'name': '테스트 카페', 'state': '서울', 'city': '종로구'},
                 'geometry': {'coordinates': [126.98, 37.57]}},
                {'properties': {'countrycode': 'JP', 'name': '테스트 카페'},
                 'geometry': {'coordinates': [139.7, 35.6]}}
            ]}).encode())
        result = lookup_place_address('테스트 카페', {}, opener)
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['candidates'][0]['coordinates'], {'lat': 37.57, 'lng': 126.98})

    def test_address_added_to_name_only_place_with_map_provenance(self):
        places = [{'name': '테스트 카페', 'address': None, 'source': 'ai_api', 'needs_review': True}]
        with patch('place_server.lookup_place_address', return_value={
            'status': 'matched', 'provider': 'naver_local_search',
            'address': '서울 종로구 세종대로 1',
            'candidates': [{'name': '테스트 카페', 'address': '서울 종로구 세종대로 1'}]
        }), patch('place_server.geocode_address', return_value=None):
            self.assertIn('좌표를 확인하지 못했습니다', resolve_missing_addresses(places)[0])
        self.assertEqual(places[0]['address'], '서울 종로구 세종대로 1')
        self.assertEqual(places[0]['address_source'], 'naver_local_search')

    def test_namesakes_use_caption_region_and_return_pin_candidate(self):
        places = [{'name': '테스트 카페', 'address': None, 'source': 'ai_api',
                   'evidence': {'quote': '부산에 있는 테스트 카페'}, 'needs_review': True}]
        lookup = {'status': 'ambiguous', 'provider': 'google_places', 'candidates': [
            {'name': '테스트 카페', 'address': '서울 종로구 1', 'coordinates': {'lat': 37.57, 'lng': 126.98}},
            {'name': '테스트 카페', 'address': '부산 해운대구 2', 'coordinates': {'lat': 35.16, 'lng': 129.16}}]}
        with patch('place_server.lookup_place_address', return_value=lookup):
            self.assertEqual(resolve_missing_addresses(places), [])
        self.assertEqual(places[0]['address'], '부산 해운대구 2')
        self.assertEqual(places[0]['coordinates'], {'lat': 35.16, 'lng': 129.16})
        self.assertEqual(places[0]['address_source'], 'google_places')
        self.assertTrue(places[0]['needs_review'])

    def test_explicit_address_requires_matching_building_number(self):
        def opener(request, timeout):
            return io.BytesIO(json.dumps({'features': [
                {'properties': {'countrycode': 'KR', 'street': '세종대로', 'housenumber': '2',
                                'state': '서울특별시', 'city': '종로구'},
                 'geometry': {'coordinates': [126.98, 37.57]}}]}).encode())
        self.assertIsNone(geocode_address('서울 종로구 세종대로 1', opener))

    def test_result_exposes_map_locations_for_pinmap(self):
        post = {'post_id': 'ig_example', 'source_url': 'https://www.instagram.com/p/example/',
                'caption': '① 테스트 카페\n서울 종로구 세종대로 1'}
        with patch('place_server.media_files', return_value=[]), patch('place_server.lookup_place_address', return_value={
            'status': 'matched', 'provider': 'google_places', 'candidates': [{
                'name': '테스트 카페', 'address': '서울 종로구 세종대로 1',
                'coordinates': {'lat': 37.57, 'lng': 126.98}}]}):
            result = extract_one(post)
        self.assertEqual(result['map_locations'][0]['coordinates'], {'lat': 37.57, 'lng': 126.98})
        self.assertEqual(result['map_locations'][0]['name'], '테스트 카페')

    def test_numbered_ocr_heading_returns_name_without_inventing_address(self):
        rows = [{'source_file': 'slide-02.jpg', 'time_seconds': None,
                 'lines': ['1. 작은 바 (합정)', '올해 가장 많이 방문한 바', '칵테일 20곳']}]
        places = ocr_named_places(rows)
        self.assertEqual(len(places), 1)
        self.assertEqual(places[0]['name'], '작은 바')
        self.assertEqual(places[0]['area_hint'], '합정')
        self.assertIsNone(places[0]['address'])
        self.assertTrue(places[0]['needs_review'])

    def test_carousel_theme_supplies_search_keyword_to_each_place(self):
        rows = [{'source_file': 'cover.jpg', 'time_seconds': None,
                 'lines': ['올해의 칵테일 20곳']},
                {'source_file': 'slide-02.jpg', 'time_seconds': None,
                 'lines': ['1. 엘리먼츠 (압구정로데오)', '좋은 한 잔']}]
        places = ocr_named_places(rows)
        self.assertEqual(places[0]['search_keyword'], '칵테일 바')

    def test_transient_ai_503_retries_with_limit(self):
        calls, delays = [], []
        def opener(request, timeout):
            calls.append(timeout)
            if len(calls) < 3:
                raise urllib.error.HTTPError('https://example.test', 503, 'Unavailable', {'Retry-After': '1'}, None)
            return io.BytesIO(b'{"ok": true}')
        self.assertEqual(request_json_with_retry(object(), opener, delays.append), {'ok': True})
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [1, 1])

    def test_ai_failure_keeps_ocr_place_names(self):
        post = {'post_id': 'ig_example', 'source_url': 'https://www.instagram.com/p/example/', 'caption': ''}
        rows = [{'source_file': 'slide-02.jpg', 'time_seconds': None,
                 'lines': ['1. 작은 바 (합정)'], 'detections': []}]
        with patch('place_server.media_files', return_value=[Path('/tmp/slide-02.jpg')]), \
             patch('place_server.prepare_images', return_value=([{'path': '/tmp/slide-02.jpg', 'source_file': 'slide-02.jpg', 'time_seconds': None}], [])), \
             patch('place_server.ocr_images', return_value=(rows, [])), \
             patch('place_server.ai_extract', return_value=([], 'AI API 분석 실패: HTTP Error 503')), \
             patch('place_server.lookup_place_address', return_value={'status': 'not_found', 'provider': 'photon_openstreetmap', 'candidates': []}):
            result = extract_one(post)
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(result['places'][0]['name'], '작은 바')
        self.assertIsNone(result['places'][0]['address'])
        self.assertIn('503', ' '.join(result['notes']))


if __name__ == '__main__':
    unittest.main()

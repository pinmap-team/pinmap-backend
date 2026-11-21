import json
import unittest
from pathlib import Path
from unittest.mock import patch

from event_extraction import ai_extract_events, event_signals, explicit_dates, extract_text_events
from place_server import extract, extract_link, extract_one, normalize_content_types


class EventExtractionTests(unittest.TestCase):
    def test_non_location_post_with_ai_summary_is_complete(self):
        post={'post_id':'ig_recipepost','source_url':'https://www.instagram.com/p/recipepost/',
              'caption':'바질 파스타를 만드는 순서와 재료를 소개합니다.'}
        with patch('place_server.complete_ai_analysis',return_value=('바질 파스타 만들기','바질과 면으로 파스타를 만드는 과정입니다.')), \
             patch('place_server.classify_content',return_value={'status':'classified','category':'recipe'}) as classify:
            result=extract_one(post,content_types=('place','event'))
        self.assertEqual(result['status'],'extracted')
        self.assertEqual(result['content_kind'],'unknown')
        self.assertEqual(result['places'],[])
        self.assertEqual(result['events'],[])
        self.assertEqual(result['classification']['category'],'recipe')
        classify.assert_called_once()

    def test_non_location_post_without_ai_summary_stays_incomplete(self):
        post={'post_id':'ig_recipepost','source_url':'https://www.instagram.com/p/recipepost/',
              'caption':'바질 파스타를 만드는 순서와 재료를 소개합니다.'}
        with patch('place_server.complete_ai_analysis',return_value=(None,None)), \
             patch('place_server.classify_content',return_value={'status':'unavailable'}):
            result=extract_one(post,content_types=('place','event'))
        self.assertEqual(result['status'],'needs_media_or_ai')

    def test_caption_exhibition_keeps_explicit_range_and_venue_evidence(self):
        caption = ('빛의 정원 전시\n기간: 2026.11.15 ~ 2026.12.20\n'
                   '운영: 10:00 ~ 19:00\n장소: 서울 문화센터\n'
                   '주소: 서울특별시 종로구 세종대로 12')
        events = extract_text_events(caption)
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event['event_type'], 'exhibition')
        self.assertEqual((event['start_date'], event['end_date']), ('2026-11-15', '2026-12-20'))
        self.assertEqual(event['venue_name'], '서울 문화센터')
        self.assertEqual(event['address'], '서울특별시 종로구 세종대로 12')
        self.assertEqual(event['evidence']['kind'], 'caption')
        self.assertTrue(event['needs_review'])

    def test_missing_year_or_invalid_calendar_date_stays_unresolved(self):
        events = extract_text_events('성수 팝업\n기간: 11월 15일 ~ 11월 30일\n장소: 성수동 공간')
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]['start_date'])
        self.assertIsNone(events[0]['end_date'])
        self.assertIn('11월 15일', events[0]['date_text'])
        self.assertEqual(explicit_dates('2026.02.30'), [])
        self.assertFalse(event_signals('서울 카페 5곳'))

    def test_separate_start_end_lines_and_one_day_range_are_preserved(self):
        event = extract_text_events('가을 전시\n시작: 2026.11.15\n종료: 2026.12.01')[0]
        self.assertEqual((event['start_date'], event['end_date']), ('2026-11-15', '2026-12-01'))
        self.assertIn('종료:', event['date_text'])
        one_day = extract_text_events('하루 팝업\n2026.11.15 ~ 2026.11.15')[0]
        self.assertEqual((one_day['start_date'], one_day['end_date']), ('2026-11-15', '2026-11-15'))

    def test_numbered_exhibition_roundup_uses_each_blocks_title_venue_and_two_digit_year(self):
        caption = ('11월 전시회 추천 BEST 2\n'
                   '1️⃣ 첫 번째 작품\n📍 서울 미술관\n🗓️ 26.11.24 ~ 27.03.28\n'
                   '2️⃣ 두 번째 작품\n📍 부산 전시관\n🗓️ 26.12.11 ~ 27.04.11\n'
                   '#11월전시회 #전시회추천')
        events = extract_text_events(caption)
        self.assertEqual(len(events), 2)
        self.assertEqual([item['title'] for item in events], ['첫 번째 작품', '두 번째 작품'])
        self.assertEqual([item['event_type'] for item in events], ['exhibition', 'exhibition'])
        self.assertEqual((events[0]['start_date'], events[0]['end_date']), ('2026-11-24', '2027-03-28'))
        self.assertEqual((events[1]['start_date'], events[1]['end_date']), ('2026-12-11', '2027-04-11'))
        self.assertEqual([item['venue_name'] for item in events], ['서울 미술관', '부산 전시관'])

    def test_reel_ocr_preserves_frame_time_and_no_ai_without_event_signal(self):
        rows = [{'source_file': 'video-frame-001500ms.jpg', 'time_seconds': 1.5,
                 'lines': ['겨울 팝업', '2026년 11월 20일 ~ 2026년 12월 1일', '장소: 중앙 광장']}]
        event = extract_text_events('', rows)[0]
        self.assertEqual(event['source'], 'media_ocr')
        self.assertEqual(event['evidence']['file'], 'video-frame-001500ms.jpg')
        self.assertEqual(event['evidence']['time_seconds'], 1.5)
        self.assertEqual((event['start_date'], event['end_date']), ('2026-11-20', '2026-12-01'))

    def test_two_events_do_not_borrow_each_others_dates(self):
        caption = ('빛의 정원 전시\n2026.11.15 ~ 2026.11.30\n장소: 미술관\n'
                   '겨울 팝업\n2026.12.05 ~ 2026.12.20\n장소: 성수 공간')
        events = extract_text_events(caption)
        self.assertEqual(len(events), 2)
        self.assertEqual((events[0]['start_date'], events[0]['end_date']), ('2026-11-15', '2026-11-30'))
        self.assertEqual((events[1]['start_date'], events[1]['end_date']), ('2026-12-05', '2026-12-20'))

    def test_ai_date_requires_observed_evidence_not_model_claim(self):
        response = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
            'events': [{'title': '성수 팝업', 'event_type': 'pop_up', 'start_date': '2026-11-15',
                        'end_date': None, 'date_text': '2026.11.15', 'time_text': None,
                        'venue_name': '성수 공간', 'address': None,
                        'evidence': '성수 팝업', 'evidence_file': '', 'source': 'caption'}]
        }, ensure_ascii=False)}]}}]}
        events, error = ai_extract_events('성수 팝업', [], [], [],
            {'MULTIUSER_AI_PROVIDER': 'gemini', 'MULTIUSER_MODEL': 'gemini-2.5-flash',
             'GEMINI_API_KEY': 'test'}, lambda _: response)
        self.assertIsNone(error)
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]['start_date'])
        self.assertIsNone(events[0]['date_text'])
        self.assertIn('원문 근거', events[0]['notes'][0])
        self.assertIsNone(events[0]['venue_name'])

    def test_ai_ocr_claim_requires_matching_observed_text(self):
        response = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
            'events': [{'title': '가짜 팝업', 'event_type': 'pop_up', 'start_date': None,
                        'end_date': None, 'date_text': None, 'time_text': None,
                        'venue_name': None, 'address': None,
                        'evidence': '가짜 팝업', 'evidence_file': 'slide.jpg', 'source': 'ocr'}]
        }, ensure_ascii=False)}]}}]}
        events, error = ai_extract_events('', [{'source_file': 'slide.jpg', 'lines': ['실제 전시 안내']}], [], [],
            {'MULTIUSER_AI_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test'}, lambda _: response)
        self.assertIsNone(error)
        self.assertEqual(events, [])

    def test_ai_reversed_date_range_is_not_published_as_an_end_date(self):
        response = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
            'events': [{'title': '겨울 전시', 'event_type': 'exhibition', 'start_date': '2026-12-20',
                        'end_date': '2026-12-01', 'date_text': '2026.12.20 ~ 2026.12.01',
                        'time_text': None, 'venue_name': None, 'address': None,
                        'evidence': '겨울 전시', 'evidence_file': '', 'source': 'caption'}]
        }, ensure_ascii=False)}]}}]}
        events, error = ai_extract_events('겨울 전시\n2026.12.20 ~ 2026.12.01', [], [], [],
            {'MULTIUSER_AI_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test'}, lambda _: response)
        self.assertIsNone(error)
        self.assertEqual(events[0]['start_date'], '2026-12-20')
        self.assertIsNone(events[0]['end_date'])
        self.assertTrue(any('종료일이 시작일보다' in note for note in events[0]['notes']))

    def test_ai_malformed_response_is_reported_without_crashing(self):
        settings = {'MULTIUSER_AI_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test'}
        for response in ([], {'candidates': [None]}, {'candidates': [{'content': None}]}):
            events, error = ai_extract_events('성수 팝업', [], [], [], settings, lambda _: response)
            self.assertEqual(events, [])
            self.assertIsInstance(error, str)

    def test_ai_does_not_publish_invented_title_time_or_other_events_date(self):
        response = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
            'events': [{'title': 'AI가 지은 전시 제목', 'event_type': 'exhibition',
                        'start_date': '2026-12-01', 'end_date': None, 'date_text': '2026.12.01',
                        'time_text': '10:00 ~ 20:00', 'venue_name': '없는 미술관', 'address': None,
                        'evidence': '빛의 전시', 'evidence_file': '', 'source': 'caption'}]
        }, ensure_ascii=False)}]}}]}
        caption = '빛의 전시\n기간: 2026.12.01'
        events, error = ai_extract_events(caption, [], [], [],
            {'MULTIUSER_AI_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test'}, lambda _: response)
        self.assertIsNone(error)
        self.assertEqual(events[0]['title'], '빛의 전시')
        self.assertIsNone(events[0]['time_text'])
        self.assertIsNone(events[0]['venue_name'])

    def test_mode_validation_and_event_only_pipeline_skips_place_search(self):
        self.assertEqual(normalize_content_types(None), ('place',))
        for invalid in ([], ['place', 'place'], ['anything'], 'event'):
            with self.assertRaises(ValueError):
                normalize_content_types(invalid)
        post = {'post_id': 'ig_abcdefgh', 'source_url': 'https://www.instagram.com/p/abcdefgh/',
                'caption': '겨울 팝업\n기간: 2026.11.15 ~ 2026.12.20\n장소: 성수 공간'}
        with patch('place_server.media_files', return_value=[]), \
             patch('place_server.ai_post_summary', return_value=('겨울 팝업', '성수의 겨울 팝업입니다.', None)), \
             patch('place_server.resolve_missing_addresses') as map_search:
            result = extract_one(post, content_types=('event',))
        self.assertEqual(result['content_kind'], 'event')
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['places'], [])
        map_search.assert_not_called()

    def test_ten_event_titles_do_not_become_places_or_map_pins(self):
        caption = '11월 전시 추천 BEST 10\n' + ''.join(
            f'{number}️⃣ 작품 {number}\n📍 서울 미술관 {number}\n🗓️ 26.11.24 ~ 27.03.28\n'
            for number in range(1, 11))
        extracted_places = [
            {'name': f'작품 {number}', 'address': None, 'source': 'ai_api',
             'evidence': {'kind': 'media_ocr', 'file': f'slide-{number}.jpg'},
             'coordinates': {'lat': 37.5, 'lng': 127.0}, 'needs_review': True}
            for number in range(1, 11)]
        venue = {'name': '서울 미술관 1', 'address': None, 'source': 'ai_api',
                 'evidence': {'kind': 'caption'}, 'coordinates': {'lat': 37.6, 'lng': 127.0},
                 'needs_review': True}
        post = {'post_id': 'ig_abcdefgh', 'source_url': 'https://www.instagram.com/p/abcdefgh/',
                'caption': caption}
        with patch('place_server.media_files', return_value=[]), \
             patch('place_server.ai_extract', return_value=(extracted_places + [venue], None)), \
             patch('place_server.ai_post_summary', return_value=('전시 추천', '전시 열 곳을 소개합니다.', None)), \
             patch('place_server.resolve_missing_addresses', return_value=[]) as map_search:
            result = extract_one(post, content_types=('place', 'event'))
        self.assertEqual(len(result['events']), 10)
        self.assertEqual(result['content_kind'], 'mixed')
        self.assertEqual([place['name'] for place in result['places']], ['서울 미술관 1'])
        self.assertEqual([location['name'] for location in result['map_locations']], ['서울 미술관 1'])
        self.assertEqual([place['name'] for place in map_search.call_args.args[0]], ['서울 미술관 1'])

    def test_place_only_carousel_remains_unchanged(self):
        post = {'post_id': 'ig_abcdefgh', 'source_url': 'https://www.instagram.com/p/abcdefgh/',
                'caption': '서울 카페 세 곳'}
        place = {'name': '서울 카페', 'address': '서울특별시 마포구 와우산로 10',
                 'source': 'caption', 'evidence': {'kind': 'caption'},
                 'coordinates': {'lat': 37.55, 'lng': 126.92}, 'needs_review': False}
        with patch('place_server.caption_places', return_value=[place]), \
             patch('place_server.media_files', return_value=[]), \
             patch('place_server.ai_post_summary', return_value=('카페 세 곳', '서울 카페를 소개합니다.', None)), \
             patch('place_server.resolve_missing_addresses', return_value=[]):
            result = extract_one(post, content_types=('place',))
        self.assertEqual(result['content_kind'], 'place')
        self.assertEqual(len(result['events']), 0)
        self.assertEqual([item['name'] for item in result['places']], ['서울 카페'])
        self.assertEqual([item['name'] for item in result['map_locations']], ['서울 카페'])

    def test_link_request_uses_isolated_media_directory_and_removes_it(self):
        observed = {'status': 'collected', 'post_id': 'ig_abcdefgh',
                    'source_url': 'https://www.instagram.com/p/abcdefgh/', 'caption': '전시'}
        result = {'post_id': 'ig_abcdefgh', 'source_url': observed['source_url'],
                  'status': 'needs_review', 'places': [], 'events': [], 'map_locations': [], 'notes': []}
        roots = []
        def collect(_url, _mode, media_root, browser_profile):
            roots.append((Path(media_root), Path(browser_profile)))
            return observed
        with patch('place_server.collect_link', side_effect=collect), \
             patch('place_server.extract_one', return_value=result), \
             patch('place_server.attach_location_images'), \
             patch('place_server.ffmpeg_bin', return_value=None):
            output = extract_link(observed['source_url'], content_types=['place', 'event'])
        self.assertFalse(output['place_only_test'])
        self.assertEqual(len(roots), 2)
        self.assertEqual(roots[0], roots[1])
        self.assertFalse(roots[0][0].parent.exists())

    def test_missing_zip_post_has_stable_event_fields(self):
        with patch('place_server.parse_zip', return_value={}):
            result = extract(b'ignored', ['notfound'])
        missing = result['results'][0]
        self.assertEqual(missing['content_kind'], 'unknown')
        self.assertEqual(missing['events'], [])


if __name__ == '__main__':
    unittest.main()

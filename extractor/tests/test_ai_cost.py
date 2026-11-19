import json
import io
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

from ai_input import compact_analysis_input, compact_text
from ai_request_cache import CACHE_SECONDS, cached_ai_response, clear_ai_cache, track_ai_cache
from place_server import request_json_with_retry


def gemini_request(text='same input', key='first-key'):
    return urllib.request.Request(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        data=json.dumps({'contents': [{'parts': [{'text': text}]}]}).encode(),
        headers={'x-goog-api-key': key, 'Content-Type': 'application/json'}, method='POST')


def complete_response():
    return {'candidates': [{'finishReason': 'STOP',
                            'content': {'parts': [{'text': '{"title":"전시","summary":"소개"}'}]}}]}


class AICostTests(unittest.TestCase):
    def setUp(self):
        clear_ai_cache()

    def test_identical_request_reuses_success_without_sharing_mutable_result(self):
        calls = []
        counts = {}
        def fetch():
            calls.append(1)
            return complete_response()
        request = gemini_request()
        with track_ai_cache(counts):
            first = cached_ai_response(request, fetch, now=lambda: 10)
            first['candidates'][0]['content']['parts'][0]['text'] = 'changed'
            second = cached_ai_response(request, fetch, now=lambda: 11)
        self.assertEqual(len(calls), 1)
        self.assertIn('전시', second['candidates'][0]['content']['parts'][0]['text'])
        self.assertEqual(counts['ai_cache_hits'], 1)
        self.assertEqual(counts['ai_cache_misses'], 1)

    def test_production_request_path_uses_cache(self):
        response = json.dumps(complete_response()).encode()
        with patch('place_server.urllib.request.urlopen',
                   side_effect=lambda request, timeout: io.BytesIO(response)) as fetch:
            request_json_with_retry(gemini_request())
            request_json_with_retry(gemini_request())
        self.assertEqual(fetch.call_count, 1)

    def test_changed_input_key_and_expiry_require_new_request(self):
        calls = []
        def fetch():
            calls.append(1)
            return complete_response()
        cached_ai_response(gemini_request(), fetch, now=lambda: 10)
        cached_ai_response(gemini_request('different'), fetch, now=lambda: 11)
        cached_ai_response(gemini_request(key='rotated-key'), fetch, now=lambda: 12)
        cached_ai_response(gemini_request(), fetch, now=lambda: 10 + CACHE_SECONDS + 1)
        self.assertEqual(len(calls), 4)

    def test_incomplete_response_is_not_cached(self):
        calls = []
        def fetch():
            calls.append(1)
            return {'candidates': [{'finishReason': 'MAX_TOKENS'}]}
        cached_ai_response(gemini_request(), fetch)
        cached_ai_response(gemini_request(), fetch)
        self.assertEqual(len(calls), 2)

    def test_cache_can_be_disabled_and_errors_are_not_cached(self):
        request = gemini_request()
        calls = []
        def fetch():
            calls.append(1)
            return complete_response()
        with patch.dict('os.environ', {'PINMAP_AI_CACHE_ENABLED': '0'}):
            cached_ai_response(request, fetch)
            cached_ai_response(request, fetch)
        self.assertEqual(len(calls), 2)

        def fail_once():
            calls.append(1)
            if len(calls) == 3:
                raise RuntimeError('temporary provider failure')
            return complete_response()
        with self.assertRaises(RuntimeError):
            cached_ai_response(request, fail_once)
        cached_ai_response(request, fail_once)
        self.assertEqual(len(calls), 4)

    def test_parallel_identical_requests_share_one_provider_call(self):
        started = threading.Event()
        release = threading.Event()
        calls = []
        results = []
        def fetch():
            calls.append(1)
            started.set()
            self.assertTrue(release.wait(2))
            return complete_response()
        def run():
            results.append(cached_ai_response(gemini_request(), fetch))
        first = threading.Thread(target=run)
        second = threading.Thread(target=run)
        first.start()
        self.assertTrue(started.wait(2))
        second.start()
        time.sleep(.03)
        release.set()
        first.join(2)
        second.join(2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 2)

    def test_compaction_keeps_middle_date_and_source_names(self):
        caption = '앞부분 ' * 900 + '\n2026.12.25 성수 팝업 일정\n' + '뒷부분 ' * 900
        rows = [{'source_file': f'slide-{i:02d}.jpg', 'time_seconds': None,
                 'lines': ['장소: 성수 전시장'] + ['반복 설명 ' * 30] * 40}
                for i in range(20)]
        places = [{'name': '성수 전시장', 'address': None, 'map_lookup': {'candidates': ['x' * 5000]},
                   'evidence': {'quote': '장소: 성수 전시장'}}]
        compact = compact_analysis_input(caption, rows, [], places, [], True, True)
        self.assertIn('2026.12.25', compact['caption'])
        self.assertLessEqual(len(compact['caption']), 8000)
        self.assertEqual(len(compact['ocr']), 20)
        self.assertEqual(compact['ocr'][-1]['file'], 'slide-19.jpg')
        self.assertNotIn('map_lookup', json.dumps(compact, ensure_ascii=False))
        self.assertLess(len(json.dumps(compact, ensure_ascii=False)), 38000)

    def test_short_evidence_is_unchanged(self):
        text = '12월 25일 성수 팝업, 장소: 문화관'
        self.assertEqual(compact_text(text, 8000), text)


if __name__ == '__main__':
    unittest.main()

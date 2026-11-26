import os
import contextlib
import io
from pathlib import Path
import tempfile
from threading import Barrier
import unittest
from unittest.mock import patch

from place_server import extract_link, extract_one, print_results


class AiOnlyPipelineTests(unittest.TestCase):
    def test_ai_only_terminal_output_has_no_review_label(self):
        output = io.StringIO()
        report = {'results': [{'route': 'ai_api', 'status': 'extracted',
                  'post_id': 'ig_Test123', 'source_url': 'https://www.instagram.com/p/Test123/',
                  'places': [{'name': '서울숲', 'address': None,
                              'coordinates': {'lat': 37.54, 'lng': 127.04},
                              'coordinate_source': 'ai_estimate', 'needs_review': False}]}]}
        with contextlib.redirect_stdout(output):
            print_results(report)
        self.assertNotIn('확인 필요', output.getvalue())

    def test_ai_only_link_collects_media_once_even_for_event_caption(self):
        modes = []
        def collect(url, mode, root, _profile):
            modes.append(mode)
            (root / 'ig_Test123').mkdir(parents=True, exist_ok=True)
            return {'status': 'collected', 'post_id': 'ig_Test123',
                    'source_url': url, 'caption': '2026년 12월 전시', 'notes': []}
        report = {'post_id': 'ig_Test123', 'source_url': 'https://www.instagram.com/p/Test123/',
                  'status': 'extracted', 'map_locations': [], 'places': [], 'events': [],
                  'notes': [], 'classification': {}}
        with patch.dict(os.environ, {'PINMAP_AI_ONLY_ANALYSIS': '1'}), \
             patch('place_server.collect_link', side_effect=collect), \
             patch('place_server.extract_one', return_value=report):
            result = extract_link(report['source_url'], content_types=['event'])
        self.assertEqual(modes, ['media'])
        self.assertEqual(result['results'][0]['status'], 'extracted')

    def test_all_visual_chunks_use_ai_without_ocr_or_map_lookup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            images = []
            for index in range(16):
                file = root / ('frame-%02d.jpg' % index)
                file.write_bytes(b'jpeg')
                images.append({'path': str(file), 'source_file': file.name,
                               'time_seconds': float(index), 'kind': 'video_frame'})
            rendezvous = Barrier(2)
            calls = []
            def analyze(_caption, _rows, chunk, _transcripts, _places, _events,
                        _need_places, _need_events, _settings, _requester, **_kwargs):
                calls.append([image['source_file'] for image in chunk])
                rendezvous.wait(timeout=2)
                first = chunk[0]['source_file']
                return {'places': [{'name': '장소 ' + first, 'address': '서울특별시 성동구 왕십리로 100',
                                    'source': 'video_frame', 'evidence': '장소 ' + first,
                                    'evidence_file': first, 'time_seconds': chunk[0]['time_seconds'],
                                    'uncertain': False, 'latitude': 37.54, 'longitude': 127.04}],
                        'events': [], 'title': '영상 장소', 'summary': '영상의 장소를 보여 줍니다.'}, None
            context = {}
            with patch.dict(os.environ, {'PINMAP_AI_ONLY_ANALYSIS': '1',
                                          'PINMAP_AI_CHUNK_SIZE': '8', 'PINMAP_AI_CHUNK_WORKERS': '2'}), \
                 patch('place_server.ai_settings', return_value={'MULTIUSER_AI_PROVIDER': 'openai',
                                                                  'OPENAI_API_KEY': 'test'}), \
                 patch('place_server.media_files', return_value=[root / 'video.mp4']), \
                 patch('place_server.prepare_images', return_value=(images, [])), \
                 patch('place_server.transcribe_videos', return_value=([], [])), \
                 patch('place_server.analyze_content', side_effect=analyze), \
                 patch('place_server.ai_post_summary', return_value=('영상 장소', '두 장소를 소개합니다.', None)), \
                 patch('place_server.classify_content', return_value={'source': 'openai_decisions'}), \
                 patch('place_server.ocr_images') as ocr, \
                 patch('place_server.resolve_missing_addresses') as lookup:
                result = extract_one({'post_id': 'ig_Test123',
                                      'source_url': 'https://www.instagram.com/reel/Test123/',
                                      'caption': '서울의 두 장소'}, content_types=('place', 'event'),
                                     analysis_context=context)
            self.assertEqual(len(calls), 2)
            self.assertEqual([name for chunk in sorted(calls) for name in chunk],
                             [image['source_file'] for image in images])
            ocr.assert_not_called()
            lookup.assert_not_called()
            self.assertEqual(context['counts']['ai_media_chunks'], 2)
            self.assertEqual(context['timings']['ocr'], 0)
            self.assertEqual(len(result['map_locations']), 2)
            self.assertTrue(all(not place['needs_review'] for place in result['places']))
            self.assertTrue(all(place['coordinate_source'] == 'ai_estimate' for place in result['places']))

    def test_ai_without_an_exact_coordinate_does_not_invent_a_pin(self):
        bundle = {'places': [{'name': '작은 전시관', 'address': '', 'source': 'caption',
                              'evidence': '작은 전시관', 'evidence_file': '',
                              'time_seconds': None, 'uncertain': True,
                              'latitude': None, 'longitude': None}],
                  'events': [], 'title': '전시관', 'summary': '작은 전시관을 소개합니다.'}
        with patch.dict(os.environ, {'PINMAP_AI_ONLY_ANALYSIS': '1'}), \
             patch('place_server.ai_settings', return_value={'MULTIUSER_AI_PROVIDER': 'openai',
                                                              'OPENAI_API_KEY': 'test'}), \
             patch('place_server.media_files', return_value=[]), \
             patch('place_server.prepare_images', return_value=([], [])), \
             patch('place_server.transcribe_videos', return_value=([], [])), \
             patch('place_server.analyze_content', return_value=(bundle, None)), \
             patch('place_server.classify_content', return_value={'source': 'openai_decisions'}):
            result = extract_one({'post_id': 'ig_Test123',
                                  'source_url': 'https://www.instagram.com/p/Test123/',
                                  'caption': '작은 전시관'}, content_types=('place',))
        self.assertEqual(result['status'], 'extracted')
        self.assertEqual(result['map_locations'], [])
        self.assertFalse(result['places'][0]['needs_review'])

    def test_visual_event_date_is_read_by_ai_without_ocr_review_notice(self):
        with tempfile.TemporaryDirectory() as temp:
            frame = Path(temp) / 'event.jpg'
            frame.write_bytes(b'jpeg')
            bundle = {'places': [], 'events': [{
                'title': '빛의 전시', 'event_type': 'exhibition',
                'start_date': '2026-12-01', 'end_date': '2026-12-10',
                'date_text': '2026.12.01 ~ 2026.12.10', 'time_text': None,
                'venue_name': '파도미술관', 'address': None,
                'evidence': '빛의 전시 2026.12.01 ~ 2026.12.10 파도미술관',
                'evidence_file': 'event.jpg', 'source': 'image'}],
                'title': '빛의 전시', 'summary': '파도미술관에서 열리는 전시를 소개합니다.'}
            image = {'path': str(frame), 'source_file': 'event.jpg',
                     'time_seconds': None, 'kind': 'image'}
            with patch.dict(os.environ, {'PINMAP_AI_ONLY_ANALYSIS': '1'}), \
                 patch('place_server.ai_settings', return_value={'MULTIUSER_AI_PROVIDER': 'openai',
                                                                  'OPENAI_API_KEY': 'test'}), \
                 patch('place_server.media_files', return_value=[frame]), \
                 patch('place_server.prepare_images', return_value=([image], [])), \
                 patch('place_server.transcribe_videos', return_value=([], [])), \
                 patch('place_server.analyze_content', return_value=(bundle, None)), \
                 patch('place_server.classify_content', return_value={'source': 'openai_decisions'}), \
                 patch('place_server.ocr_images') as ocr:
                result = extract_one({'post_id': 'ig_Test123',
                                      'source_url': 'https://www.instagram.com/p/Test123/',
                                      'caption': ''}, content_types=('event',))
            ocr.assert_not_called()
            self.assertEqual(len(result['events']), 1)
            self.assertEqual(result['events'][0]['start_date'], '2026-12-01')
            self.assertFalse(result['events'][0]['needs_review'])
            self.assertEqual(result['events'][0]['notes'], [])


if __name__ == '__main__':
    unittest.main()

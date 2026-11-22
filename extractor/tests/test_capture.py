import base64
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from place_server import extract_capture


class CaptureTests(unittest.TestCase):
    URL = 'pinmap://capture/550e8400-e29b-41d4-a716-446655440000'

    def test_capture_image_reaches_existing_analysis_pipeline(self):
        image = b'\xff\xd8\xff' + b'capture-image'
        request = {'url': self.URL, 'content_types': ['place', 'event'],
                   'image_data_url': 'data:image/jpeg;base64,' + base64.b64encode(image).decode()}

        def analyze(post, media_root, *args, **kwargs):
            self.assertEqual(post['source_url'], self.URL)
            self.assertEqual(post['caption'], '')
            self.assertEqual((Path(media_root) / post['post_id'] / 'link-slide-01.jpg').read_bytes(), image)
            self.assertEqual(kwargs['content_types'], ('place', 'event'))
            return {'source_url': self.URL, 'status': 'extracted', 'map_locations': [],
                    'ai_title': '캡처 내용', 'ai_summary': '화면에 보이는 내용을 설명해요.'}

        with patch('place_server.extract_one', side_effect=analyze), \
             patch('place_server.ffmpeg_bin', return_value=None):
            result = extract_capture(request)
        self.assertEqual(result['input'], 'screenshot')
        self.assertEqual(result['results'][0]['ai_title'], '캡처 내용')

    def test_capture_rejects_non_image_and_wrong_source(self):
        valid = {'url': self.URL, 'content_types': ['place', 'event'],
                 'image_data_url': 'data:image/jpeg;base64,' + base64.b64encode(b'not-a-jpeg').decode()}
        with self.assertRaises(ValueError):
            extract_capture(valid)
        valid['url'] = 'https://example.com/other'
        with self.assertRaises(ValueError):
            extract_capture(valid)

    def test_capture_runs_media_ocr_and_description_before_returning_record(self):
        image = b'\xff\xd8\xff' + b'capture-image'
        request = {'url': self.URL, 'content_types': ['place', 'event'],
                   'image_data_url': 'data:image/jpeg;base64,' + base64.b64encode(image).decode()}
        rows = [{'source_file': 'link-slide-01.jpg', 'time_seconds': None,
                 'lines': ['캡처 속 전시 안내', '서울특별시 종로구 세종대로 12']}]

        def explain(caption, observed, images, transcripts, *args):
            self.assertEqual(caption, '')
            self.assertEqual(observed, rows)
            self.assertEqual(images[0]['source_file'], 'link-slide-01.jpg')
            self.assertEqual(transcripts, [])
            return '캡처 속 전시 안내', '캡처에 전시 안내와 주소가 보여요. 화면의 정보에 따라 방문 장소를 확인할 수 있어요.'

        with patch('place_server.ffmpeg_bin', return_value=None), \
             patch('place_server.ocr_images', return_value=(rows, [])), \
             patch('place_server.transcribe_videos', return_value=([], [])), \
             patch('place_server.complete_ai_analysis', side_effect=explain) as analysis, \
             patch('place_server.resolve_missing_addresses', return_value=[]), \
             patch('place_server.classify_content', return_value={'status': 'classified', 'category': 'exhibition'}):
            result = extract_capture(request)['results'][0]
        analysis.assert_called_once()
        self.assertIn(result['status'], ('extracted', 'needs_review'))
        self.assertEqual(result['ai_title'], '캡처 속 전시 안내')
        self.assertEqual(result['source_url'], self.URL)
        self.assertEqual(result['media_files'], ['link-slide-01.jpg'])

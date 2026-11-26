"""The OpenAI branch must use Responses without changing the Gemini branch."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content_ai import analyze_content


class OpenAIProviderTests(unittest.TestCase):
    def test_ai_only_coordinates_are_requested_with_frame_time(self):
        sent = []
        def reply(request):
            sent.append(json.loads(request.data))
            result = {'places': [], 'events': [], 'title': '서울 산책',
                      'summary': '서울의 장소를 소개합니다.'}
            return {'status': 'completed', 'output': [{'content': [
                {'type': 'output_text', 'text': json.dumps(result)}]}]}
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as temp:
            image = Path(temp) / 'frame.jpg'
            image.write_bytes(b'jpeg')
            settings = {'MULTIUSER_AI_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-key'}
            result, error = analyze_content('', [], [{'path': str(image),
                'source_file': 'reel.mp4', 'time_seconds': 12.5}], [], [], [],
                True, False, settings, reply, ai_coordinates=True)
        self.assertIsNone(error)
        self.assertEqual(result['title'], '서울 산책')
        schema = sent[0]['text']['format']['schema']
        place = schema['properties']['places']['items']
        self.assertIn('latitude', place['required'])
        self.assertIn('longitude', place['required'])
        content = sent[0]['input'][0]['content']
        self.assertTrue(any('12.5초' in part.get('text', '') for part in content))

    def test_unified_analysis_uses_openai_responses_and_parses_result(self):
        sent = []

        def reply(request):
            sent.append(request)
            result = {'places': [], 'events': [], 'title': '성수 산책',
                      'summary': '게시물에 나온 성수의 산책 장면을 소개해요.'}
            return {'status': 'completed', 'output': [{'content': [
                {'type': 'output_text', 'text': json.dumps(result)}]}]}

        settings = {'MULTIUSER_AI_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-key',
                    'PINMAP_PLACE_AI_MODEL': 'gpt-4.1-mini'}
        result, error = analyze_content('성수 산책', [], [], [], [], [], False, False, settings, reply)
        self.assertIsNone(error)
        self.assertEqual(result['title'], '성수 산책')
        self.assertEqual(len(sent), 1)
        request = sent[0]
        self.assertEqual(request.full_url, 'https://api.openai.com/v1/responses')
        body = json.loads(request.data)
        self.assertEqual(body['model'], 'gpt-4.1-mini')
        self.assertFalse(body['store'])
        self.assertEqual(body['text']['format']['type'], 'json_schema')


if __name__ == '__main__':
    unittest.main()

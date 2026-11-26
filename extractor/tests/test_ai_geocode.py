import json
import unittest

from ai_geocode import estimate_locations


class AiGeocodeTests(unittest.TestCase):
    def test_openai_uses_text_only_structured_coordinates(self):
        requests = []
        def reply(request):
            requests.append(request)
            body = {'locations': [{'index': 0,
                                   'address': '서울특별시 성동구 뚝섬로 273',
                                   'latitude': 37.5446, 'longitude': 127.0374}]}
            return {'status': 'completed', 'output': [{'content': [
                {'type': 'output_text', 'text': json.dumps(body)}]}]}
        places = [{'name': '서울숲', 'address': '서울특별시 성동구 뚝섬로 273',
                   'evidence': {'quote': '서울숲 서울특별시 성동구 뚝섬로 273'}}]
        result, error = estimate_locations(places, {'MULTIUSER_AI_PROVIDER': 'openai',
            'OPENAI_API_KEY': 'test-key'}, reply)
        self.assertIsNone(error)
        self.assertEqual(result[0]['latitude'], 37.5446)
        self.assertEqual(requests[0].full_url, 'https://api.openai.com/v1/responses')
        payload = json.loads(requests[0].data)
        self.assertFalse(payload['store'])
        self.assertEqual(payload['text']['format']['schema']['properties']['locations']['type'], 'array')
        self.assertEqual(len(payload['input'][0]['content']), 1)

    def test_response_cannot_add_an_unrequested_place(self):
        def reply(_request):
            body = {'locations': [{'index': 3, 'address': '서울특별시 종로구 삼청로 30',
                                   'latitude': 37.58, 'longitude': 126.98}]}
            return {'status': 'completed', 'output': [{'content': [
                {'type': 'output_text', 'text': json.dumps(body)}]}]}
        places = [{'name': '서울숲', 'address': None, 'evidence': {'quote': '서울숲'}}]
        result, error = estimate_locations(places, {'OPENAI_API_KEY': 'test-key'}, reply)
        self.assertIsNone(error)
        self.assertEqual(result, {})

    def test_gemini_keeps_the_provider_switch_available(self):
        requests = []
        def reply(request):
            requests.append(request)
            body = {'locations': [{'index': 0, 'address': '서울특별시 성동구 뚝섬로 273',
                                   'latitude': 37.5446, 'longitude': 127.0374}]}
            return {'candidates': [{'finishReason': 'STOP',
                    'content': {'parts': [{'text': json.dumps(body)}]}}]}
        places = [{'name': '서울숲', 'address': '서울특별시 성동구 뚝섬로 273'}]
        result, error = estimate_locations(places, {'MULTIUSER_AI_PROVIDER': 'gemini',
            'MULTIUSER_MODEL': 'gemini-2.5-flash', 'GEMINI_API_KEY': 'test-key'}, reply)
        self.assertIsNone(error)
        self.assertEqual(result[0]['longitude'], 127.0374)
        self.assertIn('generativelanguage.googleapis.com', requests[0].full_url)


if __name__ == '__main__':
    unittest.main()

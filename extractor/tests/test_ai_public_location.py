import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_public_location import _location_from_source, _search_sources, lookup_published_location
from place_server import ADDRESS, compatible_place_addresses, detailed_korean_address


class PublishedLocationTests(unittest.TestCase):
    def setUp(self):
        self.document = ('<title>물의집 - 양평 장소 정보</title>'
                         '<div>물의집 경기 양평군 강상면 백병길 108-4</div>'
                         '<a href="/map?lat=37.48527467674748&amp;lng=127.44971332373018">지도</a>')

    def test_rural_road_address_and_published_point(self):
        self.assertTrue(detailed_korean_address('경기 양평군 강상면 백병길 108-4'))
        found = _location_from_source(self.document, '물의집', '경기 양평',
                                      ADDRESS, compatible_place_addresses)
        self.assertEqual(found['address'], '경기 양평군 강상면 백병길 108-4')
        self.assertAlmostEqual(found['coordinates']['lat'], 37.48527467674748)

    def test_wrong_venue_or_conflicting_points_is_rejected(self):
        wrong_title = self.document.replace('물의집 -', '다른집 -')
        self.assertIsNone(_location_from_source(wrong_title, '물의집', '경기 양평',
                                                ADDRESS, compatible_place_addresses))
        conflict = self.document + '<a href="/map?lat=37.60000&amp;lng=127.50000">다른 장소</a>'
        self.assertIsNone(_location_from_source(conflict, '물의집', '경기 양평',
                                                ADDRESS, compatible_place_addresses))

    def test_openai_and_gemini_source_discovery_keep_provider_branches(self):
        sent = []
        def reply(request):
            sent.append((request.full_url, json.loads(request.data)))
            if 'openai.com' in request.full_url:
                return {'status': 'completed', 'output': [{'type': 'web_search_call',
                    'action': {'sources': [{'url': 'https://polle.com/place/example'}]}}]}
            return {'candidates': [{'groundingMetadata': {'groundingChunks': [
                {'web': {'uri': 'https://polle.com/place/example'}}]}}]}
        for provider, settings in (
            ('openai', {'OPENAI_API_KEY': 'test-key', 'PINMAP_PLACE_AI_MODEL': 'gpt-4.1-mini'}),
            ('gemini', {'GEMINI_API_KEY': 'test-key', 'MULTIUSER_MODEL': 'gemini-3.8-flash'})):
            sources = _search_sources('물의집', '경기 양평',
                                      {'MULTIUSER_AI_PROVIDER': provider, **settings}, reply)
            self.assertEqual(sources, ['https://polle.com/place/example'])
        self.assertEqual(sent[0][1]['tools'][0]['type'], 'web_search')
        self.assertEqual(sent[1][1]['tools'], [{'googleSearch': {}}])

    def test_lookup_requires_published_source(self):
        with patch('ai_public_location._search_sources', return_value=['https://polle.com/place/example']), \
             patch('ai_public_location._read_source', return_value=self.document):
            found = lookup_published_location('물의집', '경기 양평', {}, lambda _request: {},
                                              ADDRESS, compatible_place_addresses)
        self.assertEqual(found['source_url'], 'https://polle.com/place/example')
        self.assertEqual(found['coordinates']['lng'], 127.44971332373018)


if __name__ == '__main__':
    unittest.main()

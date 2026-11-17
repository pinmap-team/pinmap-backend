import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from place_server import Handler, resolve_places_request


class ResolvePlacesTests(unittest.TestCase):
    def test_reuses_place_lookup_and_returns_map_location_with_evidence(self):
        lookup = {'status': 'matched', 'provider': 'google_places', 'candidates': [{
            'name': '테스트 카페', 'address': '서울 마포구 양화로 1',
            'coordinates': {'lat': 37.55, 'lng': 126.91}}]}
        with patch('place_server.lookup_place_address', return_value=lookup) as search:
            result = resolve_places_request({'places': [{
                'name': '테스트 카페', 'area_hint': '합정', 'search_keyword': '카페',
                'source': 'media_ocr', 'evidence_ids': ['image-1'],
                'evidence': {'quote': '합정의 테스트 카페'}}]})
        search.assert_called_once()
        self.assertEqual(result['schema_version'], 1)
        self.assertEqual(result['notes'], [])
        self.assertEqual(result['places'][0]['address'], '서울 마포구 양화로 1')
        location = result['map_locations'][0]
        self.assertEqual(location['coordinates'], {'lat': 37.55, 'lng': 126.91})
        self.assertEqual(location['provider'], 'google_places')
        self.assertEqual(location['evidence_ids'], ['image-1'])
        self.assertTrue(location['review_required'])
        self.assertGreater(location['confidence'], 0.5)

    def test_empty_or_invalid_input_never_contacts_map_provider(self):
        with patch('place_server.lookup_place_address') as search, \
             patch('place_server.geocode_address') as geocode:
            self.assertEqual(resolve_places_request({'places': []})['map_locations'], [])
            for invalid in ({}, {'places': [{'name': '', 'address': ''}]},
                            {'places': [{'name': 'x'}] * 21},
                            {'places': [{'name': 'x', 'evidence_ids': ['']}]},
                            {'places': [{'name': 'x', 'area_hint': 'y' * 101}]}):
                with self.assertRaises(ValueError):
                    resolve_places_request(invalid)
        search.assert_not_called()
        geocode.assert_not_called()

    def test_http_route_requires_existing_bearer_token(self):
        with patch.dict(os.environ, {'PINMAP_TEST_TOKEN': 'private-test-token'}):
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = 'http://127.0.0.1:%d/resolve-places' % server.server_port
                payload = json.dumps({'places': []}).encode('utf-8')
                unauthorized = urllib.request.Request(url, data=payload,
                                                       headers={'Content-Type': 'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(unauthorized, timeout=3)
                self.assertEqual(error.exception.code, 401)
                authorized = urllib.request.Request(url, data=payload, headers={
                    'Content-Type': 'application/json', 'Authorization': 'Bearer private-test-token'})
                with urllib.request.urlopen(authorized, timeout=3) as response:
                    body = json.load(response)
                    self.assertEqual(response.status, 200)
                self.assertEqual(body, {'schema_version': 1, 'places': [],
                                        'map_locations': [], 'notes': []})
            finally:
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()

    def test_missing_server_token_rejects_every_post(self):
        with patch.dict(os.environ, {'PINMAP_TEST_TOKEN': ''}):
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = 'http://127.0.0.1:%d/extract-link' % server.server_port
                request = urllib.request.Request(url, data=b'{"url":"https://www.instagram.com/p/abcde/"}',
                    headers={'Authorization': 'Bearer anything', 'Content-Type': 'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(error.exception.code, 503)
                self.assertEqual(json.load(error.exception)['error'], 'server_not_configured')
            finally:
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()

    def test_extract_link_rejects_non_object_json_before_collection(self):
        with patch.dict(os.environ, {'PINMAP_TEST_TOKEN': 'private-test-token'}), \
             patch('place_server.extract_link') as collect:
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = 'http://127.0.0.1:%d/extract-link' % server.server_port
                request = urllib.request.Request(url, data=b'[]', headers={
                    'Authorization': 'Bearer private-test-token', 'Content-Type': 'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(error.exception.code, 400)
                collect.assert_not_called()
            finally:
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()


if __name__ == '__main__':
    unittest.main()

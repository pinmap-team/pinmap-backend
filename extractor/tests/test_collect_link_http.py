import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import collect_link_http as fast
import place_server

URL = 'https://www.instagram.com/p/ExampleCode/'
PHOTO = {'media_type': 1, 'image_versions2': {'candidates': [
    {'url': 'https://scontent.cdninstagram.com/image.jpg', 'width': 1080}]}}


def page(post):
    script = json.dumps({'payload': json.dumps({'data': post})})
    return SimpleNamespace(status=200, url=URL, body=b'html',
                           css=lambda _: [SimpleNamespace(text=script)])


def post(**kwargs):
    return {'code': 'ExampleCode', 'caption': {'text': '성수 카페'},
            'carousel_media': [PHOTO, PHOTO], 'user': {'username': 'testauthor'}, **kwargs}


class FastCollectionTests(unittest.TestCase):
    def test_complete_images_keep_order_and_reuse_request_cache(self):
        with tempfile.TemporaryDirectory() as root:
            fetcher = lambda _: page(post())
            with patch.object(fast, 'fetch_page', side_effect=fetcher) as fetch, \
                 patch.object(fast, 'image_bytes', return_value=(b'jpeg', '.jpg', 'image/jpeg')) as download:
                first = fast.collect_photos(URL, root)
                second = fast.collect_photos(URL, root)
                self.assertEqual(first, second)
                self.assertEqual(first['caption'], '성수 카페')
                self.assertEqual(first['media_files'], ['link-cover.jpg', 'link-slide-01.jpg', 'link-slide-02.jpg'])
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(download.call_count, 2)
                self.assertTrue((Path(root) / 'ig_ExampleCode' / 'link-slide-02.jpg').is_file())

    def test_incomplete_photos_do_not_commit_any_files(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(OSError):
                fast.collect_photos(URL, root, fetcher=lambda _: page(post()),
                                    downloader=lambda _: (_ for _ in ()).throw(OSError('failed')))
            self.assertFalse((Path(root) / 'ig_ExampleCode').exists())

    def test_rejects_wrong_post_missing_photos_video_and_partial_carousel(self):
        variants = [post(code='different'), post(carousel_media=[{}]),
                    post(carousel_media=[{'media_type': 2}]), post(carousel_media_count=3)]
        with tempfile.TemporaryDirectory() as root:
            for variant in variants:
                with self.subTest(variant=variant), self.assertRaises(fast.FastCollectionUnavailable):
                    fast.collect_photos(URL, root, fetcher=lambda _: page(variant))
            with self.assertRaises(fast.FastCollectionUnavailable):
                fast.collect_photos(URL.replace('/p/', '/reel/'), root)

    def test_missing_dimensions_still_uses_original_public_candidate(self):
        media = {'image_versions2': {'candidates': [{'url': 'https://s.fbcdn.net/x'}]}}
        self.assertEqual(fast.choose_image(media), 'https://s.fbcdn.net/x')

    def test_failure_is_not_retried_in_same_request(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(fast, 'collect_photos', side_effect=fast.FastCollectionUnavailable('missing')) as http, \
             patch('place_server.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{}')) as browser:
            place_server.collect_link(URL, 'caption', root)
            place_server.collect_link(URL, 'media', root)
            self.assertEqual(http.call_count, 1)
            self.assertEqual(browser.call_count, 2)

    def test_image_host_allowlist(self):
        for url in ['http://s.cdninstagram.com/x', 'https://127.0.0.1/x',
                    'https://cdninstagram.com.evil.test/x', 'https://u:p@s.fbcdn.net/x',
                    'https://s.fbcdn.net:444/x']:
            self.assertFalse(fast.cdn_url(url), url)
        self.assertTrue(fast.cdn_url('https://s.fbcdn.net/x'))

    def test_unavailable_or_dependency_failure_uses_existing_browser(self):
        for error in [fast.FastCollectionUnavailable('public_page_unavailable'), ImportError('scrapling')]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as root, \
                 patch.object(fast, 'collect_photos', side_effect=error), \
                 patch('place_server.subprocess.run', return_value=SimpleNamespace(
                     returncode=0, stdout=json.dumps({'status': 'collected', 'caption': 'browser'}))) as browser:
                self.assertEqual(place_server.collect_link(URL, 'media', root)['caption'], 'browser')
                self.assertEqual(browser.call_args.args[0][0], 'node')

    def test_success_never_calls_browser_and_disabled_flag_does(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(fast, 'collect_photos', return_value={'media_files': [], 'status': 'collected'}) as collect, \
             patch('place_server.subprocess.run', return_value=SimpleNamespace(
                 returncode=0, stdout='{"status":"collected"}')) as browser:
            place_server.collect_link(URL, 'caption', root)
            browser.assert_not_called()
            with patch.dict('os.environ', {'PINMAP_SCRAPLING_ENABLED': '0'}):
                place_server.collect_link(URL, 'caption', root)
            self.assertEqual(browser.call_count, 1)
            self.assertEqual(collect.call_count, 1)


if __name__ == '__main__':
    unittest.main()

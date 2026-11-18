"""Fast public Instagram photo collection; incomplete results fall back to the browser."""
import base64
import concurrent.futures
import json
import os
import re
import shutil
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

MAX_IMAGE = 12 * 1024 * 1024
MAX_TOTAL = 96 * 1024 * 1024


class FastCollectionUnavailable(Exception):
    pass


def cdn_url(value):
    if not isinstance(value, str) or len(value) > 8192:
        return False
    p = urlparse(value)
    host = p.hostname or ''
    return (p.scheme == 'https' and p.port in (None, 443) and not p.username and not p.password
            and any(host == domain or host.endswith('.' + domain)
                    for domain in ('cdninstagram.com', 'fbcdn.net')))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not cdn_url(newurl):
            raise FastCollectionUnavailable('image_redirect_rejected')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def image_bytes(url, timeout=8):
    if not cdn_url(url):
        raise FastCollectionUnavailable('image_url_rejected')
    with urllib.request.build_opener(SafeRedirect()).open(url, timeout=timeout) as response:
        if int(response.headers.get('Content-Length', '0')) > MAX_IMAGE:
            raise FastCollectionUnavailable('image_too_large')
        data = response.read(MAX_IMAGE + 1)
    if not data or len(data) > MAX_IMAGE:
        raise FastCollectionUnavailable('image_too_large')
    if data[:3] == b'\xff\xd8\xff':
        suffix, mime = '.jpg', 'image/jpeg'
    elif data[:8] == b'\x89PNG\r\n\x1a\n':
        suffix, mime = '.png', 'image/png'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        suffix, mime = '.webp', 'image/webp'
    else:
        raise FastCollectionUnavailable('invalid_image')
    return data, suffix, mime


def find_post(scripts, code):
    matches = []
    visited = 0

    def walk(value, depth=0):
        nonlocal visited
        visited += 1
        if depth > 60 or visited > 150000:
            raise FastCollectionUnavailable('page_structure_limit')
        if isinstance(value, dict):
            if value.get('code') == code and ('image_versions2' in value or 'carousel_media' in value):
                matches.append(value)
            for child in value.values():
                walk(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                walk(child, depth + 1)
        elif isinstance(value, str) and 100 < len(value) < 16 * 1024 * 1024 and value.lstrip().startswith(('{', '[')):
            try:
                nested = json.loads(value)
            except ValueError:
                return
            walk(nested, depth + 1)

    for script in scripts:
        try:
            value = json.loads(script)
        except (ValueError, TypeError):
            continue
        walk(value)
    if not matches:
        raise FastCollectionUnavailable('public_post_data_missing')
    return max(matches, key=lambda p: len(p.get('carousel_media') or []) * 100 + len(p))


def choose_image(media):
    candidates = (media.get('image_versions2') or {}).get('candidates') or []
    candidates = [c for c in candidates if isinstance(c, dict) and cdn_url(c.get('url'))]
    if not candidates:
        raise FastCollectionUnavailable('photo_url_missing')
    sized = [c for c in candidates if isinstance(c.get('width'), (int, float)) and c['width'] > 0]
    return min(sized, key=lambda c: abs(c['width'] - 1080))['url'] if sized else candidates[0]['url']


def fetch_page(url):
    from scrapling.fetchers import Fetcher
    return Fetcher.get(url, timeout=8, retries=0)


def collect_photos(url, media_root, fetcher=None, downloader=None):
    """One request-local cache serves both caption and media calls. No shared user state."""
    fetcher = fetcher or fetch_page
    match = re.fullmatch(r'https://www\.instagram\.com/(p|reel|tv)/([A-Za-z0-9_-]+)/', url)
    if not match or match[1] != 'p':
        raise FastCollectionUnavailable('video_uses_browser')
    code = match[2]
    if not media_root:
        raise FastCollectionUnavailable('request_media_directory_missing')
    folder = Path(media_root) / ('ig_' + code)
    cache = folder / '.http-report.json'
    try:
        report = json.loads(cache.read_text())
        names = report.get('media_files', [])
        if (report.get('source_url') == url and names and
                all(isinstance(n, str) and Path(n).name == n and (folder / n).is_file()
                    and (folder / n).stat().st_size > 0 for n in names)):
            return report
    except (OSError, ValueError, TypeError):
        pass
    started = time.monotonic()
    deadline = started + 12
    def download_photo(link):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FastCollectionUnavailable('photo_time_budget_exceeded')
        return downloader(link) if downloader else image_bytes(link, timeout=min(6, remaining))
    page = fetcher(url)
    target = urlparse(page.url)
    if (page.status != 200 or target.hostname not in ('www.instagram.com', 'instagram.com')
            or target.path.rstrip('/') != '/p/' + code or len(page.body) > 24 * 1024 * 1024):
        raise FastCollectionUnavailable('public_page_unavailable')
    post = find_post([s.text for s in page.css('script[type="application/json"]')], code)
    children = post.get('carousel_media') or [post]
    if not isinstance(children, list) or not 1 <= len(children) <= 20:
        raise FastCollectionUnavailable('unsupported_carousel')
    declared = post.get('carousel_media_count')
    if isinstance(declared, int) and declared != len(children):
        raise FastCollectionUnavailable('incomplete_carousel')
    if any(not isinstance(child, dict) or child.get('media_type') != 1 for child in children):
        raise FastCollectionUnavailable('video_uses_browser')
    urls = [choose_image(child) for child in children]
    caption_value = post.get('caption')
    if caption_value is not None and not isinstance(caption_value, dict):
        raise FastCollectionUnavailable('invalid_caption')
    caption = (caption_value or {}).get('text') or ''
    if not isinstance(caption, str):
        raise FastCollectionUnavailable('invalid_caption')
    author = post.get('user') or {}
    profile_url = author.get('profile_pic_url') if isinstance(author, dict) else None
    def profile_image():
        if not cdn_url(profile_url):
            return None
        try:
            data, _suffix, mime = image_bytes(profile_url, timeout=2)
            return ('data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')) if len(data) <= 256 * 1024 else None
        except Exception:
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        profile = executor.submit(profile_image)
        images = list(executor.map(download_photo, urls))
        profile_data = profile.result()
    if sum(len(data) for data, _, _ in images) > MAX_TOTAL:
        raise FastCollectionUnavailable('photos_too_large')
    author = post.get('user') or {}
    username = author.get('username') if isinstance(author, dict) else None
    report = {'post_id': 'ig_' + code, 'source_url': url, 'status': 'collected',
              'caption': caption, 'author_username': username, 'author_profile_data_url': profile_data,
              'media_files': [], 'notes': [], 'collection_method': 'scrapling_http',
              'collection_seconds': round(time.monotonic() - started, 3)}
    # Commit only complete image sets, leaving browser fallback free of partial files.
    Path(media_root).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=media_root, prefix='.http-stage-') as temp:
        stage = Path(temp)
        for index, (data, suffix, _mime) in enumerate(images, 1):
            name = 'link-slide-%02d%s' % (index, suffix)
            (stage / name).write_bytes(data)
            report['media_files'].append(name)
        cover = 'link-cover' + images[0][1]
        shutil.copyfile(stage / report['media_files'][0], stage / cover)
        report['media_files'].insert(0, cover)
        folder.mkdir(parents=True, exist_ok=True)
        for name in report['media_files']:
            os.replace(stage / name, folder / name)
        cache.write_text(json.dumps(report, ensure_ascii=False))
    return report

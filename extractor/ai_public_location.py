"""Find published venue coordinates through the selected AI API's web search.

The model discovers sources, but coordinates are accepted only when the same
venue's public page actually contains both a full address and a coordinate pair.
"""

import html
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, 'redirect refused', headers, fp)


def _public_https(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname
        if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
                or parsed.port not in (None, 443) or host == 'localhost'
                or host.endswith(('.local', '.internal'))):
            return False
        try:
            ipaddress.ip_address(host)
            return False
        except ValueError:
            pass
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return bool(addresses) and all(ipaddress.ip_address(row[4][0]).is_global for row in addresses)
    except (ValueError, OSError):
        return False


def _read_source(url, opener=None):
    if not _public_https(url):
        return ''
    request = urllib.request.Request(url, headers={'User-Agent': 'PinmapPlaceResearch/1.0',
                                                   'Accept': 'text/html'})
    opener = opener or urllib.request.build_opener(NoRedirect()).open
    try:
        with opener(request, timeout=4) as response:
            if not response.headers.get('Content-Type', '').lower().startswith('text/html'):
                return ''
            return html.unescape(response.read(500001).decode('utf-8', 'ignore'))
    except (OSError, urllib.error.URLError, ValueError):
        return ''


def _search_sources(name, area, settings, requester, query_hint=''):
    provider = settings.get('MULTIUSER_AI_PROVIDER', 'openai')
    district = area.split()[-1]
    prompt = (f'Find a public listing page for the Korean venue "{name}" in "{area}". '
              f'Search for `"{name}" "{district}" address` and cite the exact venue page. '
              'The page must explicitly print the street address. Do not guess or use nearby places. '
              + query_hint)
    if provider == 'openai':
        key = settings.get('OPENAI_API_KEY', '').strip()
        model = settings.get('PINMAP_PLACE_AI_MODEL', 'gpt-4.1-mini')
        if not key:
            return []
        tool = {'type': 'web_search', 'search_context_size': 'medium'}
        body = {'model': model, 'store': False, 'input': prompt,
                'tools': [tool],
                'tool_choice': 'required', 'include': ['web_search_call.action.sources']}
        request = urllib.request.Request('https://api.openai.com/v1/responses',
            data=json.dumps(body).encode('utf-8'), method='POST',
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        response = requester(request)
        if response.get('status') != 'completed':
            return []
        return [source.get('url') for row in response.get('output', [])
                if row.get('type') == 'web_search_call'
                for source in (row.get('action') or {}).get('sources', []) if source.get('url')]
    if provider == 'gemini':
        key = settings.get('GEMINI_API_KEY', '').strip()
        model = settings.get('MULTIUSER_MODEL', 'gemini-3.8-flash')
        if not key or not re.fullmatch(r'gemini-[A-Za-z0-9.-]+', model):
            return []
        body = {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
                'tools': [{'googleSearch': {}}]}
        request = urllib.request.Request(
            'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
            data=json.dumps(body).encode('utf-8'), method='POST',
            headers={'x-goog-api-key': key, 'Content-Type': 'application/json'})
        response = requester(request)
        return [chunk.get('web', {}).get('uri') for candidate in response.get('candidates', [])
                for chunk in (candidate.get('groundingMetadata') or {}).get('groundingChunks', [])
                if chunk.get('web', {}).get('uri')]
    return []


def _published_coordinates(document):
    pairs = []
    for match in re.finditer(r'\blat\W{0,16}(\d{2}\.\d{4,})[\s\S]{0,120}?\blng\W{0,16}(\d{3}\.\d{4,})',
                             document, re.I):
        lat, lng = map(float, match.groups())
        if 33 <= lat <= 39 and 124 <= lng <= 132:
            pairs.append((lat, lng))
    if not pairs or any(abs(lat - pairs[0][0]) > .0005 or abs(lng - pairs[0][1]) > .0005
                        for lat, lng in pairs[1:]):
        return None
    return {'lat': pairs[0][0], 'lng': pairs[0][1]}


def _location_from_source(document, name, area, address_pattern, compatible):
    title = re.search(r'<title[^>]*>(.*?)</title>', document, re.I | re.S)
    clean_title = re.sub(r'[^0-9a-z가-힣]', '', html.unescape(re.sub(r'<[^>]+>', '',
        title.group(1) if title else '')).casefold())
    clean_name = re.sub(r'[^0-9a-z가-힣]', '', name.casefold())
    if not clean_name or not clean_title.startswith(clean_name):
        return None
    text = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', document))
    address = next((match.group(0).strip() for match in address_pattern.finditer(text)
                    if compatible(area, match.group(0)) and clean_name in re.sub(
                        r'[^0-9a-z가-힣]', '', text[max(0, match.start()-250):match.end()+100].casefold())), None)
    point = _published_coordinates(document)
    if not address or not point:
        return None
    return {'address': address, 'coordinates': point}


def lookup_published_location(name, area, settings, requester, address_pattern, compatible,
                              opener=None):
    """Return a source-backed exact location or None; never estimate a point."""
    if not name or len(name.strip()) < 2 or not area or not re.search(r'[가-힣]', area):
        return None
    tried = set()
    for hint in ('Search site:polle.com/place first for the exact venue name.',
                 'Search other public venue directories for the exact place.'):
        try:
            sources = _search_sources(name, area, settings, requester, hint)
        except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError):
            continue
        for url in sources[:3]:
            if not isinstance(url, str) or url in tried:
                continue
            tried.add(url)
            document = _read_source(url, opener)
            if not document:
                continue
            result = _location_from_source(document, name, area, address_pattern, compatible)
            if result:
                return {**result, 'source_url': url}
    return None

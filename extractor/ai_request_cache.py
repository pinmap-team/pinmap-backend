"""Bounded, process-local cache for identical successful model requests."""

from collections import OrderedDict
from concurrent.futures import Future
from contextlib import contextmanager
from contextvars import ContextVar
import copy
import hashlib
import json
import os
import threading
import time
from urllib.parse import urlsplit


CACHE_SECONDS = 15 * 60
MAX_ENTRIES = 32
MAX_RESPONSE_BYTES = 256 * 1024
_entries = OrderedDict()
_inflight = {}
_lock = threading.Lock()
_metrics = ContextVar('pinmap_ai_cache_metrics', default=None)


@contextmanager
def track_ai_cache(counts):
    token = _metrics.set(counts)
    try:
        yield
    finally:
        _metrics.reset(token)


def _count(name):
    counts = _metrics.get()
    if counts is not None:
        counts[name] = counts.get(name, 0) + 1


def _provider(request):
    try:
        url = urlsplit(request.full_url)
        if request.get_method() != 'POST' or url.scheme != 'https':
            return None
        if url.hostname == 'generativelanguage.googleapis.com' and url.path.endswith(':generateContent'):
            return 'gemini'
        if url.hostname == 'api.openai.com' and url.path == '/v1/responses':
            return 'openai'
    except (AttributeError, TypeError, ValueError):
        pass
    return None


def _key(request):
    digest = hashlib.sha256()
    digest.update(request.full_url.encode())
    digest.update(request.data or b'')
    # Include the credential digest so rotating a key never reuses an old response.
    for name, value in sorted(request.header_items()):
        digest.update(name.lower().encode())
        digest.update(b'\0')
        digest.update(value.encode())
        digest.update(b'\0')
    return digest.digest()


def _completed_json(response, provider):
    try:
        if provider == 'gemini':
            candidate = response['candidates'][0]
            if candidate.get('finishReason') != 'STOP':
                return False
            raw = ''.join(part.get('text', '') for part in candidate['content']['parts'])
        else:
            if response.get('status') != 'completed':
                return False
            raw = ''.join(part.get('text', '') for item in response['output']
                          for part in item.get('content', []) if part.get('type') == 'output_text')
        return isinstance(json.loads(raw), dict)
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        return False


def cached_ai_response(request, fetch, now=time.monotonic):
    """Return a copy of a prior complete response; failures are never cached."""
    provider = _provider(request)
    if provider is None or os.getenv('PINMAP_AI_CACHE_ENABLED', '1') == '0':
        return fetch()
    key = _key(request)
    with _lock:
        current = now()
        for old_key, (expires, _) in list(_entries.items()):
            if expires <= current:
                del _entries[old_key]
        cached = _entries.get(key)
        if cached is not None:
            _entries.move_to_end(key)
            _count('ai_cache_hits')
            return copy.deepcopy(cached[1])
        pending = _inflight.get(key)
        owner = pending is None
        if owner:
            pending = Future()
            _inflight[key] = pending
    if not owner:
        result = pending.result()
        _count('ai_cache_hits')
        return copy.deepcopy(result)
    _count('ai_cache_misses')
    try:
        result = fetch()
        if _completed_json(result, provider):
            encoded = json.dumps(result, ensure_ascii=False).encode()
            if len(encoded) <= MAX_RESPONSE_BYTES:
                with _lock:
                    _entries[key] = (now() + CACHE_SECONDS, copy.deepcopy(result))
                    _entries.move_to_end(key)
                    while len(_entries) > MAX_ENTRIES:
                        _entries.popitem(last=False)
        pending.set_result(copy.deepcopy(result))
        return result
    except BaseException as exc:
        pending.set_exception(exc)
        raise
    finally:
        with _lock:
            _inflight.pop(key, None)


def clear_ai_cache():
    """Test helper; production entries expire automatically."""
    with _lock:
        _entries.clear()

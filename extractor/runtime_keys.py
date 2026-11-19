"""Read one encrypted production key file, with legacy env fallback."""
import base64
import json
import os
import re
from pathlib import Path

DEFAULT_ENCRYPTED_FILE = Path(__file__).with_name('production-keys.enc.json')


def read_key_file(filename):
    if not filename:
        return {}
    source = Path(filename).expanduser().resolve(strict=True)
    if not source.is_file() or (os.name != 'nt' and source.stat().st_mode & 0o077):
        raise ValueError('PINMAP_KEYS_FILE must be a private file (mode 600)')
    values = {}
    for line in source.read_text(encoding='utf-8').splitlines():
        if not line or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match:
            raise ValueError('Invalid PINMAP_KEYS_FILE format')
        name, value = match.groups()
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        values[name] = value
    return values


def settings_with_keys(environ=None):
    environ = dict(os.environ if environ is None else environ)
    settings = dict(environ)
    local = read_key_file(environ.get('PINMAP_KEYS_FILE'))
    settings.update(local)
    source = Path(environ.get('PINMAP_KEYS_ENCRYPTED_FILE') or DEFAULT_ENCRYPTED_FILE)
    payload = json.loads(source.read_text(encoding='utf-8'))
    if payload.get('version') != 1 or not isinstance(payload.get('keys'), dict):
        raise ValueError('Invalid production key registry')
    for name, entry in payload['keys'].items():
        if entry.get('source') not in ('encrypted', 'environment') or not entry.get('environment'):
            raise ValueError(f'Invalid production key entry: {name}')
        if entry['source'] == 'environment' and name not in local:
            settings[name] = environ.get(entry['environment'], '')
    master = environ.get('PINMAP_KEYS_MASTER_KEY')
    if master:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        if not re.fullmatch(r'[0-9a-fA-F]{64}', master):
            raise ValueError('PINMAP_KEYS_MASTER_KEY must be 32 bytes in hex')
        cipher = base64.b64decode(payload['data']) + base64.b64decode(payload['tag'])
        data = AESGCM(bytes.fromhex(master)).decrypt(base64.b64decode(payload['iv']), cipher, None)
        encrypted = json.loads(data.decode('utf-8'))
        for name, entry in payload['keys'].items():
            if entry.get('source') == 'encrypted':
                value = encrypted.get(name)
                if not isinstance(value, str) or not value.strip():
                    raise ValueError(f'Missing encrypted key: {name}')
                settings[name] = value.strip()
    return settings


def get_key(name, environ=None):
    return str(settings_with_keys(environ).get(name, '')).strip()

import os
import json
import base64
import tempfile
import unittest
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from runtime_keys import get_key, settings_with_keys


class RuntimeKeysTests(unittest.TestCase):
    def test_private_file_is_opt_in(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / '.env.keys.local'
            filename.write_text('GEMINI_API_KEY="file-test-key"\n', encoding='utf-8')
            filename.chmod(0o600)
            self.assertEqual(get_key('GEMINI_API_KEY', {}), '')
            self.assertEqual(get_key('GEMINI_API_KEY', {'PINMAP_KEYS_FILE': str(filename)}), 'file-test-key')
            self.assertEqual(get_key('GEMINI_API_KEY', {
                'PINMAP_KEYS_FILE': str(filename), 'GEMINI_API_KEY': 'deployed-test-key'
            }), 'file-test-key')
            self.assertEqual(settings_with_keys({'PINMAP_KEYS_FILE': str(filename), 'GEMINI_API_KEY': ''})['GEMINI_API_KEY'],
                             'file-test-key')
            if os.name != 'nt':
                filename.chmod(0o644)
                with self.assertRaisesRegex(ValueError, 'private file'):
                    get_key('GEMINI_API_KEY', {'PINMAP_KEYS_FILE': str(filename)})

    def test_encrypted_file_takes_priority_over_legacy_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'production-keys.enc.json'
            key = os.urandom(32)
            iv = os.urandom(12)
            ciphertext = AESGCM(key).encrypt(iv, b'{"GEMINI_API_KEY":"new-test-key"}', None)
            filename.write_text(json.dumps({
                'version': 1,
                'iv': base64.b64encode(iv).decode(),
                'data': base64.b64encode(ciphertext[:-16]).decode(),
                'tag': base64.b64encode(ciphertext[-16:]).decode()
            }), encoding='utf-8')
            env = {'PINMAP_KEYS_MASTER_KEY': key.hex(), 'PINMAP_KEYS_ENCRYPTED_FILE': str(filename),
                   'GEMINI_API_KEY': 'old-test-key'}
            self.assertEqual(get_key('GEMINI_API_KEY', env), 'new-test-key')
            with self.assertRaises(Exception):
                get_key('GEMINI_API_KEY', {**env, 'PINMAP_KEYS_MASTER_KEY': os.urandom(32).hex()})


if __name__ == '__main__':
    unittest.main()

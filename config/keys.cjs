const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const crypto = require('node:crypto');

// This module is server-only. Browser-safe identifiers may be returned only by
// the existing, explicitly limited configuration endpoints.
const KEY_NAMES = new Set([
  'ASR_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_BROWSER_KEY',
  'GOOGLE_MAPS_SERVER_KEY',
  'GOOGLE_PLACES_API_KEY',
  'KAKAO_MAP_JAVASCRIPT_KEY',
  'NAVER_CLIENT_ID',
  'NAVER_CLIENT_SECRET',
  'NAVER_MAP_CLIENT_ID',
  'OPENAI_API_KEY',
  'PINMAP_EXTRACTOR_TOKEN',
  'PINMAP_TEST_ACCESS_CODE',
  'PINMAP_TEST_TOKEN',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'VLLM_API_KEY'
]);

function localKeys(env) {
  if (!env.PINMAP_KEYS_FILE) return {};
  const filename = path.resolve(env.PINMAP_KEYS_FILE);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('PINMAP_KEYS_FILE must be a private file (mode 600)');
  }
  return parseEnv(fs.readFileSync(filename, 'utf8'));
}

function encryptedKeys(env) {
  if (!env.PINMAP_KEYS_MASTER_KEY) return {};
  const key = Buffer.from(env.PINMAP_KEYS_MASTER_KEY, 'hex');
  if (key.length !== 32 || !/^[0-9a-fA-F]{64}$/.test(env.PINMAP_KEYS_MASTER_KEY)) {
    throw new Error('PINMAP_KEYS_MASTER_KEY must be 32 bytes in hex');
  }
  // Static require keeps the tracked key file inside the Vercel function bundle.
  const payload = env.PINMAP_KEYS_ENCRYPTED_FILE
    ? JSON.parse(fs.readFileSync(env.PINMAP_KEYS_ENCRYPTED_FILE, 'utf8'))
    : require('../extractor/production-keys.enc.json');
  if (payload.version !== 1) throw new Error('Unsupported encrypted key file version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  const values = JSON.parse(plaintext.toString('utf8'));
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid encrypted key file');
  return values;
}

function getKey(name, env = process.env) {
  if (!KEY_NAMES.has(name)) throw new TypeError(`Unknown key name: ${name}`);
  const encryptedValue = encryptedKeys(env)[name];
  if (typeof encryptedValue === 'string' && encryptedValue.trim()) return encryptedValue.trim();
  const fileValue = localKeys(env)[name];
  if (typeof fileValue === 'string' && fileValue.trim()) return fileValue.trim();
  const deployedValue = env[name];
  if (typeof deployedValue === 'string' && deployedValue.trim()) return deployedValue.trim();
  return '';
}

module.exports = { getKey };

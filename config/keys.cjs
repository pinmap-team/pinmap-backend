const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const crypto = require('node:crypto');

// Server-only registry. Only existing, explicitly limited endpoints may return
// browser-safe identifiers; the registry itself is never sent to a client.
function registry(env) {
  // Static require keeps the tracked file inside the Vercel function bundle.
  const payload = env.PINMAP_KEYS_ENCRYPTED_FILE
    ? JSON.parse(fs.readFileSync(env.PINMAP_KEYS_ENCRYPTED_FILE, 'utf8'))
    : require('../extractor/production-keys.enc.json');
  if (payload.version !== 1 || !payload.keys || typeof payload.keys !== 'object') {
    throw new Error('Invalid production key registry');
  }
  return payload;
}

function localKeys(env) {
  if (!env.PINMAP_KEYS_FILE) return {};
  const filename = path.resolve(env.PINMAP_KEYS_FILE);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('PINMAP_KEYS_FILE must be a private file (mode 600)');
  }
  return parseEnv(fs.readFileSync(filename, 'utf8'));
}

function encryptedKeys(env, payload) {
  if (!env.PINMAP_KEYS_MASTER_KEY) return {};
  const key = Buffer.from(env.PINMAP_KEYS_MASTER_KEY, 'hex');
  if (key.length !== 32 || !/^[0-9a-fA-F]{64}$/.test(env.PINMAP_KEYS_MASTER_KEY)) {
    throw new Error('PINMAP_KEYS_MASTER_KEY must be 32 bytes in hex');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  const values = JSON.parse(plaintext.toString('utf8'));
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid encrypted key file');
  return values;
}

function getKey(name, env = process.env) {
  const payload = registry(env);
  const entry = payload.keys[name];
  if (!entry || !['encrypted', 'environment'].includes(entry.source)) {
    throw new TypeError(`Unknown key name: ${name}`);
  }
  if (entry.source === 'encrypted' && env.PINMAP_KEYS_MASTER_KEY) {
    const value = encryptedKeys(env, payload)[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing encrypted key: ${name}`);
    return value.trim();
  }
  const fileValue = localKeys(env)[name];
  if (typeof fileValue === 'string' && fileValue.trim()) return fileValue.trim();
  const deployedValue = env[entry.environment];
  if (typeof deployedValue === 'string' && deployedValue.trim()) return deployedValue.trim();
  return '';
}

module.exports = { getKey };

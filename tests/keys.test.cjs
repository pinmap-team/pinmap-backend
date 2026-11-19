const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getKey } = require('../config/keys.cjs');

test('a private local key file is used only when selected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pinmap-keys-'));
  const filename = path.join(directory, '.env.keys.local');
  try {
    fs.writeFileSync(filename, 'GEMINI_API_KEY="file-test-key"\n', {mode:0o600});
    assert.equal(getKey('GEMINI_API_KEY', {}), '');
    assert.equal(getKey('GEMINI_API_KEY', {PINMAP_KEYS_FILE:filename}), 'file-test-key');
    assert.equal(getKey('GEMINI_API_KEY', {PINMAP_KEYS_FILE:filename,GEMINI_API_KEY:'deployed-test-key'}), 'file-test-key');
    assert.throws(() => getKey('NOT_AN_API_KEY', {PINMAP_KEYS_FILE:filename}), /Unknown key name/);
    fs.chmodSync(filename, 0o644);
    assert.throws(() => getKey('GEMINI_API_KEY', {PINMAP_KEYS_FILE:filename}), /private file/);
  } finally {
    fs.rmSync(directory, {recursive:true,force:true});
  }
});

test('one encrypted file takes priority over legacy deployed values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pinmap-sealed-'));
  const filename = path.join(directory, 'production-keys.enc.json');
  const master = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({GEMINI_API_KEY:'new-test-key'})), cipher.final()]);
  fs.writeFileSync(filename, JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
  try {
    const env = {PINMAP_KEYS_MASTER_KEY:master.toString('hex'), PINMAP_KEYS_ENCRYPTED_FILE:filename, GEMINI_API_KEY:'old-test-key'};
    assert.equal(getKey('GEMINI_API_KEY', env), 'new-test-key');
    assert.throws(() => getKey('GEMINI_API_KEY', {...env,PINMAP_KEYS_MASTER_KEY:crypto.randomBytes(32).toString('hex')}));
  } finally {
    fs.rmSync(directory, {recursive:true,force:true});
  }
});

#!/usr/bin/env node
// Encrypts the local private edit file into the one tracked production key file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');

const root = path.resolve(__dirname, '..');
const source = path.join(root, '.env.keys.local');
const masterFile = path.join(root, '.keys-master.local');
const target = path.join(root, 'extractor/production-keys.enc.json');

for (const filename of [source, masterFile]) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (process.platform !== 'win32' && stat.mode & 0o077)) {
    throw new Error('Local key input files must have mode 600');
  }
}
const master = fs.readFileSync(masterFile, 'utf8').trim();
if (!/^[0-9a-fA-F]{64}$/.test(master)) throw new Error('Invalid master key file');
const values = parseEnv(fs.readFileSync(source, 'utf8'));
const registry = JSON.parse(fs.readFileSync(target, 'utf8'));
if (registry.version !== 1 || !registry.keys || typeof registry.keys !== 'object') {
  throw new Error('Invalid production key registry');
}
for (const [name, value] of Object.entries(values)) {
  if (!registry.keys[name]) throw new Error(`Key is not listed in registry: ${name}`);
  if (registry.keys[name].source === 'external') throw new Error(`Credential is managed outside Pinmap: ${name}`);
  if (!value || ['[SENSITIVE]', '[REDACTED]'].includes(value)) throw new Error(`Key has no usable value: ${name}`);
  registry.keys[name].source = 'encrypted';
  if (registry.keys[name].comment.includes('이 파일에 없') || registry.keys[name].comment.includes('환경 변수를 참조')) {
    registry.keys[name].comment = '값은 암호문에 들어 있습니다. 기존 환경 변수는 복호화 키가 없는 배포의 대체 경로입니다.';
  }
}
for (const [name, entry] of Object.entries(registry.keys)) {
  if (entry.source === 'encrypted' && !values[name]) throw new Error(`Encrypted key missing from local edit file: ${name}`);
}
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(master, 'hex'), iv);
const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
const sealed = {
  ...registry,
  iv: iv.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  data: data.toString('base64')
};
fs.writeFileSync(target, JSON.stringify(sealed, null, 2) + '\n', {mode: 0o644});
process.stdout.write(`Updated encrypted key file (${Object.keys(values).length} entries).\n`);

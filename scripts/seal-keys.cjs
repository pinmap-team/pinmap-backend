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
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(master, 'hex'), iv);
const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
const sealed = {
  version: 1,
  algorithm: 'AES-256-GCM',
  iv: iv.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  data: data.toString('base64')
};
fs.writeFileSync(target, JSON.stringify(sealed, null, 2) + '\n', {mode: 0o644});
process.stdout.write(`Updated encrypted key file (${Object.keys(values).length} entries).\n`);

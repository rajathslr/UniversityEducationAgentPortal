'use strict';
// Generates a self-signed TLS certificate into certs/ if one is not already
// present. Pure JS (selfsigned/node-forge) — no OpenSSL needed.
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const dir = path.join(__dirname, '..', 'certs');
const keyPath = path.join(dir, 'server.key');
const certPath = path.join(dir, 'server.cert');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  console.log('Certificate already exists at certs/ — leaving it in place.');
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, {
  days: 825,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' }, // DNS
        { type: 7, ip: '127.0.0.1' },    // IP
      ],
    },
  ],
});

fs.writeFileSync(keyPath, pems.private);
fs.writeFileSync(certPath, pems.cert);
console.log('Generated self-signed certificate:');
console.log('  certs/server.key');
console.log('  certs/server.cert');
console.log('(Self-signed — browsers will show a one-time "not trusted" warning.)');

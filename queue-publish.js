#!/usr/bin/env node
'use strict';

//
// queue-publish.js — Publish a JSON envelope to the queue server via HTTP.
//
// Reads JSON from stdin, POSTs to http://127.0.0.1:4223/pub?ch=<channel>.
// Falls back to writing a file if the server is not available.
//
// Usage:
//   echo '{"eventId":"..."}' | node queue-publish.js [--channel hooks|scanner]
//
// No npm dependencies — uses Node.js built-in http module.
//

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_DIR = '/tmp/claude-watcher';
const PORT = 4223;
const TIMEOUT_MS = 2000;

// Parse --channel arg (default: hooks)
let channel = 'hooks';
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--channel' && process.argv[i + 1]) {
        channel = process.argv[i + 1];
        i++;
    }
}

// Read all stdin
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').trim();

    if (!body) {
        process.stderr.write('queue-publish: empty input on stdin\n');
        process.exit(1);
    }

    // Validate JSON
    try {
        JSON.parse(body);
    } catch (e) {
        process.stderr.write('queue-publish: invalid JSON on stdin: ' + e.message + '\n');
        process.exit(1);
    }

    // POST to queue server
    const options = {
        hostname: '127.0.0.1',
        port: PORT,
        path: `/pub?ch=${encodeURIComponent(channel)}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
            if (res.statusCode === 200) {
                process.exit(0);
            } else {
                process.stderr.write('queue-publish: server returned ' + res.statusCode + ': ' + data + '\n');
                writeFallback(body);
            }
        });
    });

    req.on('error', (e) => {
        process.stderr.write('queue-publish: connection error: ' + e.message + '\n');
        writeFallback(body);
    });

    req.on('timeout', () => {
        req.destroy();
        process.stderr.write('queue-publish: connection timeout\n');
        writeFallback(body);
    });

    req.write(body);
    req.end();
});

function writeFallback(body) {
    const dir = path.join(BASE_DIR, 'queue', channel);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    const ts = Date.now();
    const filePath = path.join(dir, `${ts}-fallback-${process.pid}.json`);
    try {
        fs.writeFileSync(filePath, body, 'utf8');
        process.stderr.write('queue-publish: wrote fallback file: ' + filePath + '\n');
    } catch (e) {
        process.stderr.write('queue-publish: failed to write fallback: ' + e.message + '\n');
    }
    process.exit(1);
}

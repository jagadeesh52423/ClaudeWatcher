#!/usr/bin/env node
'use strict';

//
// queue-wait-reply.js — Wait for a reply from the queue server via long-poll.
//
// Falls back to file polling if the server is not available.
// Prints reply JSON to stdout on success, exits 1 on timeout.
//
// Usage:
//   node queue-wait-reply.js <replyId> <timeoutSeconds> <replyFilePath>
//
// No npm dependencies — uses Node.js built-in http and fs modules.
//

const http = require('http');
const fs = require('fs');

const PORT = 4223;
const FILE_POLL_MS = 500;

const replyId = process.argv[2];
const timeoutSec = parseInt(process.argv[3], 10) || 120;
const replyFilePath = process.argv[4];

if (!replyId || !replyFilePath) {
    process.stderr.write('queue-wait-reply: usage: queue-wait-reply.js <replyId> <timeoutSec> <replyFilePath>\n');
    process.exit(1);
}

let resolved = false;

function finish(data) {
    if (resolved) return;
    resolved = true;
    process.stdout.write(data.trim() + '\n');
    process.exit(0);
}

// Try queue server first
const timeoutMs = timeoutSec * 1000;
const reqUrl = `http://127.0.0.1:${PORT}/reply?id=${encodeURIComponent(replyId)}&timeout=${timeoutMs}`;

const req = http.get(reqUrl, { timeout: timeoutMs + 5000 }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        if (res.statusCode === 200 && body && body.trim()) {
            finish(body);
        } else {
            // 204 or empty — timeout from server
            if (!resolved) process.exit(1);
        }
    });
});

req.on('error', (e) => {
    // Server not running — fall back to file polling
    process.stderr.write('queue-wait-reply: server unavailable (' + e.message + '), falling back to file poll\n');
    startFilePoll();
});

req.on('timeout', () => {
    req.destroy();
    if (!resolved) process.exit(1);
});

// File poll fallback
function startFilePoll() {
    const deadline = Date.now() + timeoutMs;

    const timer = setInterval(() => {
        if (resolved) {
            clearInterval(timer);
            return;
        }

        if (Date.now() >= deadline) {
            clearInterval(timer);
            process.exit(1);
        }

        try {
            if (fs.existsSync(replyFilePath)) {
                const data = fs.readFileSync(replyFilePath, 'utf8');
                if (data && data.trim()) {
                    clearInterval(timer);
                    finish(data);
                }
            }
        } catch (_) {
            // File not ready yet — retry
        }
    }, FILE_POLL_MS);
}

#!/usr/bin/env node
'use strict';

//
// queue-server.js — Simple persistent HTTP queue server for claudeWatcher.
//
// Replaces the external NATS message broker with a self-contained queue
// using only Node.js built-ins (http, fs, path, crypto).
//
// Endpoints:
//   GET  /health              → 200 {"status":"ok","pid":...,"uptime":...}
//   POST /pub?ch=<channel>    → publish message (body = JSON string)
//   GET  /sub?ch=<channel>&timeout=<ms> → long-poll for next message
//   POST /reply?id=<replyId>  → deliver reply (body = JSON string)
//   GET  /reply?id=<replyId>&timeout=<ms> → long-poll for reply
//
// Port: 4223 (localhost only)
// No npm dependencies.
//

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

// ─── Constants ─────────────────────────────────────────────────────────────

const PORT = 4223;
const BASE_DIR = '/tmp/claude-watcher';
const QUEUE_DIRS = {
    hooks: path.join(BASE_DIR, 'queue', 'hooks'),
    scanner: path.join(BASE_DIR, 'queue', 'scanner'),
};
const REPLY_DIR = path.join(BASE_DIR, 'reply');
const PID_FILE = path.join(BASE_DIR, 'queue-server.pid');
const LOG_FILE = path.join(BASE_DIR, 'watcher.log');

// ─── In-memory state ───────────────────────────────────────────────────────

const queues = { hooks: [], scanner: [] };       // Array of { data: string, file: string }
const subscribers = { hooks: [], scanner: [] };   // Array of { resolve, timer }
const replyWaiters = {};                          // replyId -> [{ resolve, timer }]

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [queue-server] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ─── Directory setup ───────────────────────────────────────────────────────

function ensureDirs() {
    const dirs = [BASE_DIR, QUEUE_DIRS.hooks, QUEUE_DIRS.scanner, REPLY_DIR];
    for (const d of dirs) {
        fs.mkdirSync(d, { recursive: true });
    }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

function checkSingleton() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (existingPid && !isNaN(existingPid) && existingPid !== process.pid) {
                try {
                    process.kill(existingPid, 0);
                    log(`Queue server already running (PID ${existingPid}). Exiting.`);
                    process.exit(0);
                } catch (_) {
                    // Process not alive, stale PID file
                    log(`Stale PID file found (PID ${existingPid}), overwriting.`);
                }
            }
        }
    } catch (_) {}
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function cleanupPidFile() {
    try {
        const content = fs.readFileSync(PID_FILE, 'utf8').trim();
        if (content === String(process.pid)) {
            fs.unlinkSync(PID_FILE);
        }
    } catch (_) {}
}

// ─── Load existing files on startup (disaster recovery) ────────────────────

function loadExistingFiles() {
    for (const [channel, dir] of Object.entries(QUEUE_DIRS)) {
        let files;
        try {
            files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
        } catch (_) { continue; }

        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const data = fs.readFileSync(filePath, 'utf8');
                JSON.parse(data); // validate
                queues[channel].push({ data, file: filePath });
            } catch (e) {
                log(`Skipping corrupt queue file ${filePath}: ${e.message}`);
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
        }
        if (queues[channel].length > 0) {
            log(`Loaded ${queues[channel].length} existing messages for channel '${channel}'`);
        }
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function respond(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

// ─── POST /pub ─────────────────────────────────────────────────────────────

async function handlePublish(req, res, channel) {
    if (!queues[channel]) {
        return respond(res, 400, { error: `unknown channel: ${channel}` });
    }

    const body = await readBody(req);
    // Validate JSON
    try {
        JSON.parse(body);
    } catch (e) {
        return respond(res, 400, { error: `invalid JSON: ${e.message}` });
    }

    // Write to disk first
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const fileName = `${ts}-${rand}.json`;
    const filePath = path.join(QUEUE_DIRS[channel], fileName);
    try {
        fs.writeFileSync(filePath, body, 'utf8');
    } catch (e) {
        log(`Failed to write queue file ${filePath}: ${e.message}`);
        return respond(res, 500, { error: 'failed to persist message' });
    }

    // Check if a subscriber is waiting
    if (subscribers[channel].length > 0) {
        const waiter = subscribers[channel].shift();
        clearTimeout(waiter.timer);
        waiter.resolve({ data: body, file: filePath });
        return respond(res, 200, { ok: true });
    }

    // No subscriber waiting — push to in-memory queue
    queues[channel].push({ data: body, file: filePath });
    return respond(res, 200, { ok: true });
}

// ─── GET /sub ──────────────────────────────────────────────────────────────

async function handleSubscribe(req, res, channel, timeoutMs) {
    if (!queues[channel]) {
        return respond(res, 400, { error: `unknown channel: ${channel}` });
    }

    const timeout = timeoutMs || 30000;

    // If messages are queued, return immediately
    if (queues[channel].length > 0) {
        const msg = queues[channel].shift();
        // Delete disk file
        try { fs.unlinkSync(msg.file); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(msg.data);
        return;
    }

    // No messages — long-poll
    const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            // Remove this waiter from the array
            const idx = subscribers[channel].indexOf(waiter);
            if (idx !== -1) subscribers[channel].splice(idx, 1);
            resolve(null); // timeout
        }, timeout);

        const waiter = { resolve, timer };
        subscribers[channel].push(waiter);
    });

    const result = await promise;
    if (result) {
        // Message delivered by publisher
        try { fs.unlinkSync(result.file); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result.data);
    } else {
        // Timeout
        res.writeHead(204);
        res.end();
    }
}

// ─── POST /reply ───────────────────────────────────────────────────────────

async function handleReplyPost(req, res, replyId) {
    if (!replyId) {
        return respond(res, 400, { error: 'missing id parameter' });
    }

    const body = await readBody(req);
    try {
        JSON.parse(body);
    } catch (e) {
        return respond(res, 400, { error: `invalid JSON: ${e.message}` });
    }

    // Write to disk
    const filePath = path.join(REPLY_DIR, `${replyId}.json`);
    try {
        fs.writeFileSync(filePath, body, 'utf8');
    } catch (e) {
        log(`Failed to write reply file ${filePath}: ${e.message}`);
        return respond(res, 500, { error: 'failed to persist reply' });
    }

    // Wake reply waiters
    if (replyWaiters[replyId]) {
        for (const waiter of replyWaiters[replyId]) {
            clearTimeout(waiter.timer);
            waiter.resolve(body);
        }
        delete replyWaiters[replyId];
    }

    return respond(res, 200, { ok: true });
}

// ─── GET /reply ────────────────────────────────────────────────────────────

async function handleReplyGet(req, res, replyId, timeoutMs) {
    if (!replyId) {
        return respond(res, 400, { error: 'missing id parameter' });
    }

    const timeout = timeoutMs || 120000;

    // Check if reply file already exists
    const filePath = path.join(REPLY_DIR, `${replyId}.json`);
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            if (data && data.trim()) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(data);
                return;
            }
        }
    } catch (_) {}

    // Long-poll for reply
    const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            // Remove this waiter
            if (replyWaiters[replyId]) {
                const idx = replyWaiters[replyId].indexOf(waiter);
                if (idx !== -1) replyWaiters[replyId].splice(idx, 1);
                if (replyWaiters[replyId].length === 0) delete replyWaiters[replyId];
            }
            resolve(null);
        }, timeout);

        const waiter = { resolve, timer };
        if (!replyWaiters[replyId]) replyWaiters[replyId] = [];
        replyWaiters[replyId].push(waiter);
    });

    const result = await promise;
    if (result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
    } else {
        res.writeHead(204);
        res.end();
    }
}

// ─── Request router ────────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query;

    try {
        if (pathname === '/health' && req.method === 'GET') {
            return respond(res, 200, {
                status: 'ok',
                pid: process.pid,
                uptime: Math.floor((Date.now() - startTime) / 1000),
            });
        }

        if (pathname === '/pub' && req.method === 'POST') {
            return await handlePublish(req, res, query.ch);
        }

        if (pathname === '/sub' && req.method === 'GET') {
            return await handleSubscribe(req, res, query.ch, parseInt(query.timeout, 10) || undefined);
        }

        if (pathname === '/reply' && req.method === 'POST') {
            return await handleReplyPost(req, res, query.id);
        }

        if (pathname === '/reply' && req.method === 'GET') {
            return await handleReplyGet(req, res, query.id, parseInt(query.timeout, 10) || undefined);
        }

        respond(res, 404, { error: 'not found' });
    } catch (e) {
        log(`Request error: ${e.message}`);
        try { respond(res, 500, { error: e.message }); } catch (_) {}
    }
}

// ─── Startup ───────────────────────────────────────────────────────────────

const startTime = Date.now();

ensureDirs();
checkSingleton();
loadExistingFiles();

const server = http.createServer(handleRequest);

server.listen(PORT, '127.0.0.1', () => {
    log(`Queue server started on 127.0.0.1:${PORT} (PID: ${process.pid})`);
});

server.on('error', (e) => {
    log(`Server error: ${e.message}`);
    if (e.code === 'EADDRINUSE') {
        log(`Port ${PORT} already in use. Another queue server may be running.`);
        cleanupPidFile();
        process.exit(1);
    }
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown(signal) {
    log(`Queue server received ${signal}, shutting down...`);
    server.close(() => {
        cleanupPidFile();
        log('Queue server stopped.');
        process.exit(0);
    });
    // Force exit after 3s if close hangs
    setTimeout(() => {
        cleanupPidFile();
        process.exit(0);
    }, 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    log(`Queue server uncaught exception: ${err.message}\n${err.stack}`);
});

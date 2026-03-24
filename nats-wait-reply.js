#!/usr/bin/env node
//
// nats-wait-reply.js — Wait for a reply on a NATS subject with file-poll fallback
//
// Subscribes to a NATS subject AND polls a reply file. First to deliver wins.
// Prints the reply JSON to stdout and exits 0.
// On timeout, exits 1 (caller handles fallback).
//
// Usage:
//   node nats-wait-reply.js <replySubject> <timeoutSeconds> <replyFilePath>
//

"use strict";

const { connect, StringCodec } = require("nats");
const fs = require("fs");

const sc = StringCodec();

const replySubject = process.argv[2];
const timeoutSec = parseInt(process.argv[3], 10) || 120;
const replyFilePath = process.argv[4];

if (!replySubject || !replyFilePath) {
    process.stderr.write("nats-wait-reply: usage: nats-wait-reply.js <subject> <timeoutSec> <filePath>\n");
    process.exit(1);
}

let resolved = false;
let timeoutTimer = null;
let filePollTimer = null;
let nc = null;
let sub = null;

function finish(data) {
    if (resolved) return;
    resolved = true;
    // Clean up all timers and connections
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (filePollTimer) clearInterval(filePollTimer);
    if (sub) { try { sub.unsubscribe(); } catch (_) {} }
    process.stdout.write(data.trim() + "\n");
    // Close NATS and exit
    if (nc) {
        nc.close().catch(() => {}).finally(() => process.exit(0));
    } else {
        setTimeout(() => process.exit(0), 50);
    }
}

async function main() {
    const deadline = Date.now() + timeoutSec * 1000;

    // --- Timeout (set up first, before any async work) ---
    timeoutTimer = setTimeout(async () => {
        if (resolved) return;
        if (filePollTimer) clearInterval(filePollTimer);
        if (sub) { try { sub.unsubscribe(); } catch (_) {} }
        if (nc) { try { await nc.close(); } catch (_) {} }
        process.exit(1);
    }, Math.max(0, deadline - Date.now()));

    // --- File poll (secondary safety net, set up before NATS) ---
    const FILE_POLL_INTERVAL_MS = 5000;
    filePollTimer = setInterval(() => {
        if (resolved) {
            clearInterval(filePollTimer);
            return;
        }
        try {
            if (fs.existsSync(replyFilePath)) {
                const data = fs.readFileSync(replyFilePath, "utf8");
                if (data && data.trim()) {
                    finish(data);
                }
            }
        } catch (_) {
            // File not ready yet or read error — ignore, will retry
        }
    }, FILE_POLL_INTERVAL_MS);

    // --- NATS subscription (primary) ---
    try {
        nc = await connect({
            servers: "nats://localhost:4222",
            timeout: 2000,
            maxReconnectAttempts: -1,
            reconnectTimeWait: 1000,
        });

        sub = nc.subscribe(replySubject, { max: 1 });

        // Async iterator — will yield when a message arrives
        (async () => {
            for await (const msg of sub) {
                const data = sc.decode(msg.data);
                finish(data);
            }
        })().catch(() => {});
    } catch (e) {
        // NATS not available — file poll is the only channel
        process.stderr.write("nats-wait-reply: NATS connect failed, file-poll only: " + e.message + "\n");
    }
}

main().catch((e) => {
    process.stderr.write("nats-wait-reply: unexpected error: " + e.message + "\n");
    process.exit(1);
});

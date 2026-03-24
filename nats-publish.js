#!/usr/bin/env node
//
// nats-publish.js — Publish a JSON envelope to NATS subject "claude.hooks"
//
// Reads envelope JSON from stdin, publishes to nats://localhost:4222.
// Exits 0 on success, non-zero on any failure (connection error, timeout, etc.).
//
// Usage:
//   echo '{"eventId":"...","type":"PermissionRequest",...}' | node nats-publish.js
//   # or via the hook script:
//   timeout 3 node nats-publish.js <<< "$envelope"
//

"use strict";

const { connect, StringCodec } = require("nats");

const sc = StringCodec();

async function main() {
    // Read envelope from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const envelope = Buffer.concat(chunks).toString("utf8").trim();

    if (!envelope) {
        process.stderr.write("nats-publish: empty envelope on stdin\n");
        process.exit(1);
    }

    // Validate JSON
    try {
        JSON.parse(envelope);
    } catch (e) {
        process.stderr.write("nats-publish: invalid JSON on stdin: " + e.message + "\n");
        process.exit(1);
    }

    let nc;
    try {
        nc = await connect({
            servers: "nats://localhost:4222",
            timeout: 2000,       // connection timeout 2s (publish wraps in 3s via shell timeout)
            maxReconnectAttempts: 0,  // do not retry — fail fast
        });
    } catch (e) {
        process.stderr.write("nats-publish: connection failed: " + e.message + "\n");
        process.exit(1);
    }

    try {
        nc.publish("claude.hooks", sc.encode(envelope));
        await nc.flush();
    } catch (e) {
        process.stderr.write("nats-publish: publish failed: " + e.message + "\n");
        await nc.close().catch(() => {});
        process.exit(1);
    }

    await nc.close();
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write("nats-publish: unexpected error: " + e.message + "\n");
    process.exit(1);
});

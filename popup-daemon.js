#!/usr/bin/env node
'use strict';

//
// popup-daemon.js — Single consumer daemon for Claude Code hook events.
//
// Replaces the old bash popup-daemon. Manages a priority queue of hook events,
// shows one popup at a time via popup-gui.js, handles NATS + file-queue transport,
// and maintains session state files.
//

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync, spawn } = require('child_process');
const crypto = require('crypto');

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_DIR = '/tmp/claude-watcher';
const QUEUE_HOOKS_DIR = path.join(BASE_DIR, 'queue', 'hooks');
const QUEUE_SCANNER_DIR = path.join(BASE_DIR, 'queue', 'scanner');
const SESSION_STATE_DIR = path.join(BASE_DIR, 'session-state');
const ALWAYS_ALLOW_DIR = path.join(BASE_DIR, 'always-allow');
const REPLY_DIR = path.join(BASE_DIR, 'reply');
const PID_FILE = path.join(BASE_DIR, 'daemon.pid');
const STATUS_FILE = path.join(BASE_DIR, 'daemon-status.json');

const POPUP_GUI_PATH = path.join(__dirname, 'popup-gui.js');

const NATS_URL = 'nats://localhost:4222';
const NATS_CONNECT_RETRIES = 3;
const NATS_CONNECT_RETRY_DELAY_MS = 2000;
const NATS_RECONNECT_INTERVAL_MS = 30000;

const FILE_POLL_FAST_MS = 1000;   // file-only mode
const FILE_POLL_SLOW_MS = 5000;   // NATS-connected safety net

const DEDUP_TTL_MS = 60000;
const DEDUP_CLEANUP_INTERVAL_MS = 30000;

const ALWAYS_ALLOW_TTL_MS = 300000; // 5 minutes

const STARVATION_THRESHOLD_MS = 60000;

const QUEUE_TIMEOUT_CHECK_INTERVAL_MS = 5000;
const HOOK_TIMEOUT_MS = 105000; // 105s — 15s buffer before hook's own 120s

const POPUP_TIMEOUT_MS = 120000;

const POST_TOOL_USE_AUTO_RESOLVE_MS = 5000;
const SESSION_END_AUTO_RESOLVE_MS = 2000;

const STATUS_WRITE_INTERVAL_MS = 10000;

// ─── State ──────────────────────────────────────────────────────────────────

const highPriorityQueue = [];
const lowPriorityQueue = [];

let activePopup = null; // { entry, process, autoResolvable, autoResolveTimer }

const pendingReplies = new Map(); // entryId -> PendingReply
const recentEventIds = new Map(); // eventId -> expiryTimestamp
const alwaysAllowCache = new Map(); // toolName -> expiryTimestamp
const idleNotifiedPanes = new Set(); // pane ids that have been idle-notified

let natsConnection = null;
let natsStatus = 'disconnected'; // 'connected' | 'disconnected' | 'file-only'
let natsSubscriptions = [];
let natsReconnectTimer = null;

let filePollTimer = null;
let filePollIntervalMs = FILE_POLL_FAST_MS;

let dedupCleanupTimer = null;
let queueTimeoutTimer = null;
let statusWriteTimer = null;

const startTime = Date.now();

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [popup-daemon] ${msg}`;
    try { console.error(line); } catch (_) { /* ignore EPIPE */ }
    try {
        fs.appendFileSync(path.join(BASE_DIR, 'watcher.log'), line + '\n');
    } catch (_) { /* ignore */ }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function ensureDirs() {
    const dirs = [
        BASE_DIR,
        path.join(BASE_DIR, 'queue'),
        QUEUE_HOOKS_DIR,
        QUEUE_SCANNER_DIR,
        SESSION_STATE_DIR,
        ALWAYS_ALLOW_DIR,
        REPLY_DIR,
    ];
    for (const d of dirs) {
        fs.mkdirSync(d, { recursive: true });
    }
}

function generateEntryId(sessionId, toolName) {
    const ts = Date.now();
    const rand = crypto.randomBytes(2).toString('hex');
    return `${sessionId || 'unknown'}:${toolName || 'none'}:${ts}:${rand}`;
}

function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

// ─── Singleton Enforcement ──────────────────────────────────────────────────

function checkSingleton() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (existingPid && !isNaN(existingPid)) {
                try {
                    process.kill(existingPid, 0); // check if alive
                    console.error(`popup-daemon already running (PID ${existingPid}). Exiting.`);
                    process.exit(1);
                } catch (_) {
                    // Process not alive, stale PID file — proceed
                    log(`Stale PID file found (PID ${existingPid}), overwriting.`);
                }
            }
        }
    } catch (_) { /* PID file unreadable, proceed */ }

    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    log(`Daemon started, PID ${process.pid}`);
}

function killOrphanedPopups() {
    try {
        execSync('pkill -f "popup-gui.js" 2>/dev/null || true', { stdio: 'ignore', timeout: 5000 });
        log('Killed orphaned osascript/popup-gui.js processes (if any).');
    } catch (_) { /* ignore */ }
}

function cleanupPidFile() {
    try {
        const content = fs.readFileSync(PID_FILE, 'utf8').trim();
        if (content === String(process.pid)) {
            fs.unlinkSync(PID_FILE);
        }
    } catch (_) { /* ignore */ }
}

// ─── Deduplication ──────────────────────────────────────────────────────────

function isDuplicate(eventId) {
    if (!eventId) return false;
    const expiry = recentEventIds.get(eventId);
    if (expiry && expiry > Date.now()) return true;
    return false;
}

function markSeen(eventId) {
    if (!eventId) return;
    recentEventIds.set(eventId, Date.now() + DEDUP_TTL_MS);
}

function cleanupDedupSet() {
    const now = Date.now();
    for (const [id, expiry] of recentEventIds) {
        if (expiry <= now) recentEventIds.delete(id);
    }
}

// ─── Always-Allow Cache ─────────────────────────────────────────────────────

function isAlwaysAllowed(toolName) {
    if (!toolName) return false;
    const expiry = alwaysAllowCache.get(toolName);
    if (expiry && expiry > Date.now()) return true;
    if (expiry) alwaysAllowCache.delete(toolName);
    return false;
}

function setAlwaysAllow(toolName) {
    if (!toolName) return;
    alwaysAllowCache.set(toolName, Date.now() + ALWAYS_ALLOW_TTL_MS);
}

// ─── Reply Delivery ─────────────────────────────────────────────────────────

function buildPermissionReply(behavior, extras) {
    const decision = { behavior };
    if (extras && extras.updatedPermissions) {
        decision.updatedPermissions = extras.updatedPermissions;
    }
    if (extras && extras.message) decision.message = extras.message;
    if (extras && extras.updatedInput) decision.updatedInput = extras.updatedInput;
    return {
        hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision,
        },
    };
}

function buildElicitationReply(action, response) {
    const reply = {
        hookSpecificOutput: {
            hookEventName: 'Elicitation',
            action,
        },
    };
    if (action === 'accept' && response) {
        reply.hookSpecificOutput.response = response;
    }
    return reply;
}

function safeDefaultReply(eventType) {
    if (eventType === 'PermissionRequest') {
        return buildPermissionReply('allow');
    }
    if (eventType === 'Elicitation') {
        return buildElicitationReply('decline');
    }
    return null;
}

async function deliverReply(entryId, replyJson) {
    const pending = pendingReplies.get(entryId);
    if (!pending) return;
    pendingReplies.delete(entryId);

    const jsonStr = JSON.stringify(replyJson);

    if (pending.deliveryChannel === 'nats' && natsConnection) {
        try {
            const sc = natsStringCodec();
            natsConnection.publish(pending.replySubject, sc.encode(jsonStr));
            log(`Reply delivered via NATS: ${pending.replySubject}`);
            return;
        } catch (e) {
            log(`NATS reply publish failed for ${pending.replySubject}: ${e.message}. Falling back to file.`);
        }
    }

    // File fallback
    try {
        fs.writeFileSync(pending.replyFilePath, jsonStr, 'utf8');
        log(`Reply delivered via file: ${pending.replyFilePath}`);
        // Schedule cleanup of reply file after 30s
        setTimeout(() => {
            try { fs.unlinkSync(pending.replyFilePath); } catch (_) {}
        }, 30000);
    } catch (e) {
        log(`Failed to write reply file ${pending.replyFilePath}: ${e.message}`);
    }
}

// ─── NATS ───────────────────────────────────────────────────────────────────

let _natsModule = null;
let _natsStringCodec = null;

function loadNats() {
    if (!_natsModule) {
        try {
            _natsModule = require('nats');
        } catch (e) {
            log(`Cannot load nats module: ${e.message}`);
            return null;
        }
    }
    return _natsModule;
}

function natsStringCodec() {
    if (!_natsStringCodec) {
        const nats = loadNats();
        if (nats) _natsStringCodec = nats.StringCodec();
    }
    return _natsStringCodec;
}

async function connectNats() {
    const nats = loadNats();
    if (!nats) {
        log('NATS module not available. Running in file-queue-only mode.');
        natsStatus = 'file-only';
        return false;
    }

    for (let attempt = 1; attempt <= NATS_CONNECT_RETRIES; attempt++) {
        try {
            log(`NATS connect attempt ${attempt}/${NATS_CONNECT_RETRIES}...`);
            natsConnection = await nats.connect({
                servers: NATS_URL,
                reconnect: false, // We manage reconnect ourselves
                timeout: 5000,
            });
            natsStatus = 'connected';
            log('NATS connected.');

            // Monitor for close/disconnect
            (async () => {
                try {
                    const err = await natsConnection.closed();
                    log(`NATS connection closed${err ? ': ' + err.message : ''}.`);
                    handleNatsDisconnect();
                } catch (_) {}
            })();

            await subscribeNats();
            return true;
        } catch (e) {
            log(`NATS connect attempt ${attempt} failed: ${e.message}`);
            if (attempt < NATS_CONNECT_RETRIES) {
                await sleep(NATS_CONNECT_RETRY_DELAY_MS);
            }
        }
    }

    log('NATS unavailable after retries. Running in file-queue-only mode.');
    natsStatus = 'file-only';
    return false;
}

async function subscribeNats() {
    if (!natsConnection) return;
    const sc = natsStringCodec();

    // Unsubscribe existing
    for (const sub of natsSubscriptions) {
        try { sub.unsubscribe(); } catch (_) {}
    }
    natsSubscriptions = [];

    // Subscribe to claude.hooks (high priority)
    const hooksSub = natsConnection.subscribe('claude.hooks');
    natsSubscriptions.push(hooksSub);
    (async () => {
        for await (const msg of hooksSub) {
            try {
                const data = JSON.parse(sc.decode(msg.data));
                enqueueEvent(data, 'high', 'nats');
            } catch (e) {
                log(`Error parsing NATS hooks message: ${e.message}`);
            }
        }
    })();

    // Subscribe to claude.scanner (low priority)
    const scannerSub = natsConnection.subscribe('claude.scanner');
    natsSubscriptions.push(scannerSub);
    (async () => {
        for await (const msg of scannerSub) {
            try {
                const data = JSON.parse(sc.decode(msg.data));
                enqueueEvent(data, 'low', 'nats');
            } catch (e) {
                log(`Error parsing NATS scanner message: ${e.message}`);
            }
        }
    })();

    log('Subscribed to claude.hooks and claude.scanner.');
}

function handleNatsDisconnect() {
    natsConnection = null;
    natsStatus = 'disconnected';
    natsSubscriptions = [];
    log('NATS disconnected. Switching to file-queue mode.');
    setFilePollInterval(FILE_POLL_FAST_MS);
    scheduleNatsReconnect();
}

function scheduleNatsReconnect() {
    if (natsReconnectTimer) return;
    natsReconnectTimer = setInterval(async () => {
        if (natsStatus === 'connected') {
            clearInterval(natsReconnectTimer);
            natsReconnectTimer = null;
            return;
        }
        log('Attempting NATS reconnect...');
        const connected = await connectNats();
        if (connected) {
            clearInterval(natsReconnectTimer);
            natsReconnectTimer = null;
            log('NATS reconnected. Draining file queue.');
            setFilePollInterval(FILE_POLL_SLOW_MS);
            await drainFileQueues();
        }
    }, NATS_RECONNECT_INTERVAL_MS);
}

// ─── File Queue ─────────────────────────────────────────────────────────────

function setFilePollInterval(ms) {
    if (filePollTimer) clearInterval(filePollTimer);
    filePollIntervalMs = ms;
    filePollTimer = setInterval(pollFileQueues, filePollIntervalMs);
}

function pollFileQueues() {
    pollDirectory(QUEUE_HOOKS_DIR, 'high');
    pollDirectory(QUEUE_SCANNER_DIR, 'low');
}

function pollDirectory(dir, priority) {
    let files;
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    } catch (_) { return; }

    for (const file of files) {
        const filePath = path.join(dir, file);
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            enqueueEvent(data, priority, 'file');
            fs.unlinkSync(filePath);
        } catch (e) {
            log(`Error reading queue file ${filePath}: ${e.message}`);
            // Try to remove corrupt files
            try { fs.unlinkSync(filePath); } catch (_) {}
        }
    }
}

async function drainFileQueues() {
    pollFileQueues();
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

function enqueueEvent(envelope, priority, source) {
    const eventId = envelope.eventId;
    const eventType = envelope.type;
    const sessionId = envelope.session_id;
    const toolName = envelope.tool_name;
    const hookLaunchTimestamp = envelope.hookLaunchTimestamp || Date.now();

    // Deduplication
    if (isDuplicate(eventId)) {
        return;
    }
    markSeen(eventId);

    // Non-popup events: handle immediately
    if (!isPopupEvent(eventType) && !isCleanupEvent(eventType)) {
        // PostToolUse: update session state only, no queue dropping
        if (eventType === 'PostToolUse') {
            handlePostToolUse(envelope);
        } else {
            handleStateOnlyEvent(envelope);
        }
        return;
    }

    // SessionEnd: cleanup logic
    if (eventType === 'SessionEnd') {
        handleSessionEnd(envelope);
        return;
    }

    // Queue the event (PermissionRequest, Elicitation)
    const entryId = generateEntryId(sessionId, toolName);
    const entry = {
        entryId,
        eventId,
        type: eventType,
        session_id: sessionId,
        tool_name: toolName,
        cwd: envelope.cwd,
        raw_payload: envelope.raw_payload || envelope,
        hookLaunchTimestamp,
        enqueuedAt: Date.now(),
        source,
        envelope,
    };

    // Store pending reply for blocking hooks
    if (eventType === 'PermissionRequest' || eventType === 'Elicitation') {
        pendingReplies.set(entryId, {
            deliveryChannel: source === 'nats' ? 'nats' : 'file',
            replySubject: envelope.replySubject || '',
            replyFilePath: envelope.replyFilePath || '',
            hookLaunchTimestamp,
        });
    }

    if (priority === 'high') {
        highPriorityQueue.push(entry);
    } else {
        lowPriorityQueue.push(entry);
    }

    log(`Enqueued ${eventType} [${entryId}] priority=${priority} source=${source}`);
    tryNextPopup();
}

function isPopupEvent(type) {
    return type === 'PermissionRequest' || type === 'Elicitation';
}


function isCleanupEvent(type) {
    return type === 'SessionEnd';
}

// ─── State-Only Events ──────────────────────────────────────────────────────

function handleStateOnlyEvent(envelope) {
    const type = envelope.type;
    const sessionId = envelope.session_id;
    const toolName = envelope.tool_name || '';
    const message = envelope.raw_payload?.message || envelope.message || '';
    const pane = envelope.raw_payload?.pane || envelope.pane || '';
    const cwd = envelope.cwd || '';
    const project = cwd ? path.basename(cwd) : '';

    switch (type) {
        case 'PreToolUse':
            writeSessionState(sessionId, 'working', pane, project, toolName, message);
            break;
        case 'PostToolUseFailure':
            writeSessionState(sessionId, 'error', pane, project, toolName, message);
            break;
        case 'Stop':
            writeSessionState(sessionId, 'idle', pane, project, toolName, message);
            break;
        case 'UserPromptSubmit':
            writeSessionState(sessionId, 'working', pane, project, toolName, message);
            break;
        case 'SubagentStart':
            writeSessionState(sessionId, 'working (subagent)', pane, project, toolName, message);
            break;
        case 'SubagentStop':
            writeSessionState(sessionId, 'working', pane, project, toolName, message);
            break;
        case 'TeammateIdle':
            writeSessionState(sessionId, 'needs-attention', pane, project, toolName, message);
            break;
        case 'TaskCompleted':
            writeSessionState(sessionId, 'completed', pane, project, toolName, message);
            break;
        case 'Notification':
            handleNotification(envelope);
            break;
        default:
            log(`Unhandled state-only event: ${type}`);
    }
}

// ─── Session State ──────────────────────────────────────────────────────────

function writeSessionState(sessionId, state, pane, project, tool, message) {
    if (!sessionId) return;
    const filePath = path.join(SESSION_STATE_DIR, sessionId);
    const content = [
        `state=${state}`,
        `pane=${pane || ''}`,
        `project=${project || ''}`,
        `session_id=${sessionId}`,
        `tool=${tool || ''}`,
        `message=${message || ''}`,
        `timestamp=${Math.floor(Date.now() / 1000)}`,
    ].join('\n') + '\n';
    try {
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (e) {
        log(`Failed to write session state for ${sessionId}: ${e.message}`);
    }
}

// ─── Notification Events ────────────────────────────────────────────────────

function handleNotification(envelope) {
    const raw = envelope.raw_payload || envelope;
    const notifType = raw.notification_type || '';
    const message = raw.message || '';
    const sessionId = envelope.session_id || '';
    const pane = raw.pane || envelope.pane || '';
    const cwd = envelope.cwd || '';
    const project = cwd ? path.basename(cwd) : '';

    // Clear idle guard on non-idle events
    if (notifType !== 'idle_prompt') {
        const paneKey = pane.replace(/[:\.]/g, '_');
        idleNotifiedPanes.delete(paneKey);
    }

    let subtitle = project;
    if (pane && pane !== 'unknown' && pane !== 'no-tmux') {
        subtitle = `${pane} — ${project}`;
    }

    switch (notifType) {
        case 'permission_prompt':
            showMacNotification('Claude Code', message || 'Permission needed', subtitle);
            break;
        case 'idle_prompt': {
            // Update session state
            writeSessionState(sessionId, 'idle', pane, project, '', message || 'Session is idle');
            // Dedup: once per idle per pane
            const paneKey = pane.replace(/[:\.]/g, '_');
            if (!idleNotifiedPanes.has(paneKey)) {
                idleNotifiedPanes.add(paneKey);
                showMacNotification('Claude Code', message || 'Session is idle', subtitle);
                log(`Idle notification sent for pane ${pane}`);
            } else {
                log(`Idle notification already sent for pane ${pane}, skipping`);
            }
            break;
        }
        case 'elicitation_dialog':
            showMacNotification('Claude Code', message || 'Elicitation requires attention', subtitle);
            break;
        case 'auth_success':
            showMacNotification('Claude Code', message || 'Authentication successful', subtitle);
            break;
        default:
            showMacNotification('Claude Code', message || 'Needs attention', subtitle);
            break;
    }
}

function showMacNotification(title, message, subtitle) {
    try {
        // Try terminal-notifier first
        try {
            execFileSync('which', ['terminal-notifier'], { stdio: 'ignore', timeout: 2000 });
            const args = ['-title', title, '-message', message, '-sound', 'Glass'];
            if (subtitle) args.push('-subtitle', subtitle);
            const child = spawn('terminal-notifier', args, { stdio: 'ignore', detached: true });
            child.unref();
            return;
        } catch (_) { /* terminal-notifier not available */ }

        // Fallback to osascript
        const escapedMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const escapedSub = (subtitle || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        let script = `display notification "${escapedMsg}" with title "${title}" sound name "Glass"`;
        if (subtitle) script = `display notification "${escapedMsg}" with title "${title}" subtitle "${escapedSub}" sound name "Glass"`;
        const child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
        child.unref();
    } catch (e) {
        log(`Failed to show macOS notification: ${e.message}`);
    }
}

// ─── PostToolUse Drop Logic ─────────────────────────────────────────────────

function handlePostToolUse(envelope) {
    const cwd = envelope.cwd || '';
    const project = cwd ? path.basename(cwd) : '';
    const pane = envelope.raw_payload?.pane || envelope.pane || '';
    const message = envelope.raw_payload?.message || envelope.message || '';
    const sessionId = envelope.session_id;
    const toolName = envelope.tool_name;

    // Update session state only — queue items are removed when their reply is delivered
    writeSessionState(sessionId, 'working', pane, project, toolName, message);
}


// ─── SessionEnd Cleanup ─────────────────────────────────────────────────────

function handleSessionEnd(envelope) {
    const sessionId = envelope.session_id;
    const cwd = envelope.cwd || '';
    const project = cwd ? path.basename(cwd) : '';
    const pane = envelope.raw_payload?.pane || envelope.pane || '';

    if (!sessionId) return;

    // Write final state
    writeSessionState(sessionId, 'done', pane, project, '', 'Session ended');

    // Remove all queue entries for session
    dropSessionEntries(sessionId);

    // Delete hook queue files matching session_id (encoded in filename)
    deleteSessionFiles(QUEUE_HOOKS_DIR, sessionId);

    // Delete reply files for session
    deleteSessionReplyFiles(sessionId);

    // Handle active popup
    if (activePopup && activePopup.entry && activePopup.entry.session_id === sessionId) {
        log(`SessionEnd: active popup belongs to session ${sessionId}, auto-resolving in ${SESSION_END_AUTO_RESOLVE_MS}ms`);
        activePopup.autoResolvable = true;
        if (!activePopup.autoResolveTimer) {
            activePopup.autoResolveTimer = setTimeout(() => {
                if (activePopup && activePopup.autoResolvable) {
                    autoResolveActivePopup('safe-default');
                }
            }, SESSION_END_AUTO_RESOLVE_MS);
        }
    }

    // Delete session state file (after a brief delay so "done" state is readable)
    setTimeout(() => {
        try {
            fs.unlinkSync(path.join(SESSION_STATE_DIR, sessionId));
        } catch (_) {}
    }, 2000);

    log(`SessionEnd cleanup complete for ${sessionId}`);
    tryNextPopup();
}

function dropSessionEntries(sessionId) {
    const dropFromQueue = (queue, queueName) => {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].session_id === sessionId) {
                const entry = queue.splice(i, 1)[0];
                log(`SessionEnd: dropped ${entry.type} [${entry.entryId}] from ${queueName}`);
                if (entry.type === 'PermissionRequest' || entry.type === 'Elicitation') {
                    const reply = safeDefaultReply(entry.type);
                    if (reply) deliverReply(entry.entryId, reply);
                }
            }
        }
    };
    dropFromQueue(highPriorityQueue, 'highPriorityQueue');
    dropFromQueue(lowPriorityQueue, 'lowPriorityQueue');
}

function deleteSessionFiles(dir, sessionId) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            // Filename format: <ts_ms>-<session_id>-<pid>.json
            if (file.includes(`-${sessionId}-`)) {
                try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
            }
        }
    } catch (_) {}
}

function deleteSessionReplyFiles(sessionId) {
    try {
        const files = fs.readdirSync(REPLY_DIR);
        for (const file of files) {
            // Reply filename: <session_id>-<pid>.json
            if (file.startsWith(`${sessionId}-`)) {
                try { fs.unlinkSync(path.join(REPLY_DIR, file)); } catch (_) {}
            }
        }
    } catch (_) {}
}

// ─── Queue Timeout ──────────────────────────────────────────────────────────

function checkQueueTimeouts() {
    const now = Date.now();
    const checkQueue = (queue, queueName) => {
        for (let i = queue.length - 1; i >= 0; i--) {
            const entry = queue[i];
            if ((entry.type === 'PermissionRequest' || entry.type === 'Elicitation') &&
                entry.hookLaunchTimestamp + HOOK_TIMEOUT_MS < now) {
                queue.splice(i, 1);
                log(`Queue timeout: auto-resolving ${entry.type} [${entry.entryId}] from ${queueName}`);
                const reply = safeDefaultReply(entry.type);
                if (reply) deliverReply(entry.entryId, reply);
            }
        }
    };
    checkQueue(highPriorityQueue, 'highPriorityQueue');
    checkQueue(lowPriorityQueue, 'lowPriorityQueue');
}

// ─── Starvation Prevention ──────────────────────────────────────────────────

function checkStarvation() {
    if (lowPriorityQueue.length === 0) return;
    const oldest = lowPriorityQueue[0];
    if (Date.now() - oldest.enqueuedAt > STARVATION_THRESHOLD_MS) {
        const promoted = lowPriorityQueue.shift();
        highPriorityQueue.unshift(promoted);
        log(`Starvation prevention: promoted [${promoted.entryId}] to high priority`);
    }
}

// ─── tryNextPopup ───────────────────────────────────────────────────────────

function tryNextPopup() {
    if (activePopup) return; // Already showing one

    // Starvation check
    checkStarvation();

    // Dequeue: high priority first
    let entry = highPriorityQueue.shift();
    if (!entry && lowPriorityQueue.length > 0) {
        entry = lowPriorityQueue.shift();
    }

    if (!entry) return;

    // Only popup events should be in the queue at this point
    if (entry.type === 'PermissionRequest') {
        // Check always-allow cache
        if (isAlwaysAllowed(entry.tool_name)) {
            log(`Auto-allowing ${entry.tool_name} (always-allow cache hit)`);
            const reply = buildPermissionReply('allow');
            deliverReply(entry.entryId, reply);
            // Process next
            setImmediate(tryNextPopup);
            return;
        }
        showPermissionPopup(entry);
    } else if (entry.type === 'Elicitation') {
        showElicitationPopup(entry);
    } else {
        // Shouldn't happen, but handle gracefully
        log(`Unexpected event type in queue: ${entry.type}`);
        setImmediate(tryNextPopup);
    }
}

// ─── Popup Execution ────────────────────────────────────────────────────────

function showPermissionPopup(entry) {
    const raw = entry.raw_payload || {};
    const tool = entry.tool_name || raw.tool_name || 'Unknown Tool';
    const toolInput = raw.tool_input || {};

    // Check if this is a tool with dynamic options (e.g., AskUserQuestion)
    const questions = toolInput.questions || [];
    if (questions.length > 0 && questions[0].options && questions[0].options.length > 0) {
        return showPermissionWithOptions(entry, tool, questions[0], raw);
    }

    // Build summary from actual Claude Code payload fields
    let summary = '';
    if (toolInput.description) {
        summary = toolInput.description;
    }
    if (toolInput.command) {
        summary += (summary ? '\n\n' : '') + toolInput.command;
    } else if (toolInput.file_path) {
        summary += (summary ? '\n\n' : '') + toolInput.file_path;
    }
    if (!summary && Object.keys(toolInput).length > 0) {
        const s = JSON.stringify(toolInput);
        summary = s.length > 500 ? s.slice(0, 497) + '...' : s;
        if (summary === '{}') summary = '';
    }

    const cwd = entry.cwd || raw.cwd || '';
    const project = cwd ? path.basename(cwd) : '';

    const params = {
        type: 'permission',
        tool,
        summary,
        project,
    };

    runPopup(entry, params, (result) => {
        if (!result || result === 'ERROR:timeout' || result.startsWith('ERROR:')) {
            log(`Permission popup error/timeout for ${tool}, defaulting to allow`);
            const reply = buildPermissionReply('allow');
            deliverReply(entry.entryId, reply);
        } else if (result === 'Allow Once') {
            const reply = buildPermissionReply('allow');
            deliverReply(entry.entryId, reply);
        } else if (result === 'Always Allow') {
            setAlwaysAllow(tool);
            const permSuggestions = raw.permission_suggestions || [];
            const reply = buildPermissionReply('allow', {
                updatedPermissions: permSuggestions.length > 0 ? permSuggestions : undefined,
            });
            deliverReply(entry.entryId, reply);
        } else if (result === 'Deny') {
            const reply = buildPermissionReply('deny', { message: 'User denied via popup' });
            deliverReply(entry.entryId, reply);
        } else {
            const reply = buildPermissionReply('allow');
            deliverReply(entry.entryId, reply);
        }
    });
}

function showPermissionWithOptions(entry, tool, question, raw) {
    const qText = question.question || question.header || '';
    const options = (question.options || []).map(o => o.label || o.value || String(o));
    const isMultiSelect = !!question.multiSelect;

    const params = {
        type: 'options',
        title: 'Claude Code' + (tool ? ' \u2014 ' + tool : ''),
        message: qText || 'Choose an option:',
        options,
        multiSelect: isMultiSelect,
    };

    runPopup(entry, params, (result) => {
        if (!result || result === 'SKIP' || result.startsWith('ERROR:')) {
            const reply = buildPermissionReply('allow');
            deliverReply(entry.entryId, reply);
            return;
        }

        let answer;
        if (isMultiSelect) {
            const parts = result.split('|');
            const selected = [];
            parts.forEach(p => {
                if (p.startsWith('OTHER:')) {
                    selected.push(p.slice(6));
                } else {
                    const idx = parseInt(p, 10) - 1;
                    if (idx >= 0 && idx < options.length) selected.push(options[idx]);
                }
            });
            answer = selected.join(', ');
        } else if (result.startsWith('OTHER:')) {
            answer = result.slice(6);
        } else {
            const match = result.match(/^(\d+)\.\s+(.+)$/);
            answer = match ? match[2] : result;
        }

        const reply = buildPermissionReply('allow');
        reply.hookSpecificOutput.decision.updatedInput = { answers: {} };
        reply.hookSpecificOutput.decision.updatedInput.answers[qText] = answer;
        deliverReply(entry.entryId, reply);
    });
}

function showElicitationPopup(entry) {
    const raw = entry.raw_payload || {};

    const elicitationData = raw.elicitation || raw;
    const schema = elicitationData.schema || {};
    const title = elicitationData.title || raw.title || 'Claude Code';
    const message = elicitationData.message || elicitationData.description ||
                    raw.message || raw.prompt || 'Please respond:';

    // Extract options from multiple locations (matching old hook handler)
    let options = [];
    let isMultiSelect = false;

    // 1. schema.enum
    if (schema.enum && schema.enum.length > 0) {
        options = schema.enum;
    }
    // 2. questions[0].options
    if (options.length === 0 && raw.questions && raw.questions[0]) {
        const q = raw.questions[0];
        isMultiSelect = !!q.multiSelect;
        (q.options || []).forEach(o => {
            options.push(o.label || o.value || String(o));
        });
    }
    // 3. top-level options array
    if (options.length === 0 && Array.isArray(raw.options)) {
        raw.options.forEach(o => {
            options.push(typeof o === 'string' ? o : (o.label || o.value || String(o)));
        });
    }

    let params;

    if (options.length > 0) {
        params = {
            type: 'options',
            title,
            message,
            options,
            multiSelect: isMultiSelect,
        };
    } else if (schema.type === 'string') {
        params = {
            type: 'text',
            title,
            message,
        };
    } else {
        params = {
            type: 'text',
            title,
            message,
        };
    }

    runPopup(entry, params, (result) => {
        if (!result || result === 'ERROR:timeout' || result.startsWith('ERROR:')) {
            log(`Elicitation popup error/timeout, defaulting to decline`);
            const reply = buildElicitationReply('decline');
            deliverReply(entry.entryId, reply);
        } else if (result === 'SKIP' || result === '__SKIP__') {
            const reply = buildElicitationReply('decline');
            deliverReply(entry.entryId, reply);
        } else if (result.startsWith('OTHER:')) {
            const text = result.substring(6);
            const reply = buildElicitationReply('accept', { text });
            deliverReply(entry.entryId, reply);
        } else if (params.type === 'text') {
            const reply = buildElicitationReply('accept', { text: result });
            deliverReply(entry.entryId, reply);
        } else {
            // Options result: "N. label"
            const match = result.match(/^\d+\.\s+(.+)$/);
            const selectedOption = match ? match[1] : result;
            const reply = buildElicitationReply('accept', { selectedOption });
            deliverReply(entry.entryId, reply);
        }
    });
}

function runPopup(entry, params, callback) {
    // Write params to temp file
    const paramsFileName = `popup-params-${Date.now()}-${randomHex(4)}.json`;
    const paramsFilePath = path.join(BASE_DIR, paramsFileName);
    fs.writeFileSync(paramsFilePath, JSON.stringify(params), 'utf8');

    activePopup = {
        entry,
        autoResolvable: false,
        autoResolveTimer: null,
        resolved: false,
        callback,
        paramsFilePath,
        process: null,
    };

    log(`Showing popup: ${entry.type} ${entry.tool_name || ''} [${entry.entryId}]`);

    // Play a sound when the popup appears (async, fire-and-forget)
    try {
        log(`Playing sound: Glass.aiff`);
        const soundProc = spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], {
            stdio: 'ignore',
            detached: true
        });
        soundProc.on('error', (e) => log(`Sound error: ${e.message}`));
        soundProc.unref();
    } catch (e) {
        log(`Failed to spawn sound: ${e.message}`);
    }

    // Use spawn for async popup execution
    const child = spawn('osascript', ['-l', 'JavaScript', POPUP_GUI_PATH, paramsFilePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: POPUP_TIMEOUT_MS,
    });

    activePopup.process = child;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    // Set overall timeout
    const timeoutHandle = setTimeout(() => {
        if (!activePopup || activePopup.resolved) return;
        log(`Popup timeout for [${entry.entryId}], killing process`);
        try { child.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
        }, 2000);
        resolvePopup('ERROR:timeout');
    }, POPUP_TIMEOUT_MS);

    child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        if (activePopup && !activePopup.resolved) {
            const result = stdout.trim();
            if (code !== 0 && !result) {
                log(`Popup exited with code ${code}. stderr: ${stderr.trim()}`);
                resolvePopup('ERROR:exit-code-' + code);
            } else {
                resolvePopup(result);
            }
        }
    });

    child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        log(`Popup spawn error: ${err.message}`);
        if (activePopup && !activePopup.resolved) {
            resolvePopup('ERROR:spawn-failed');
        }
    });
}

function resolvePopup(result) {
    if (!activePopup || activePopup.resolved) return;
    activePopup.resolved = true;

    const popup = activePopup;
    const callback = popup.callback;
    const entry = popup.entry;

    // Clear auto-resolve timer
    if (popup.autoResolveTimer) {
        clearTimeout(popup.autoResolveTimer);
        popup.autoResolveTimer = null;
    }

    // Clean up params file
    try { fs.unlinkSync(popup.paramsFilePath); } catch (_) {}

    activePopup = null;

    log(`Popup resolved: [${entry.entryId}] result="${result}"`);
    callback(result);

    // Process next
    setImmediate(tryNextPopup);
}

function autoResolveActivePopup(mode) {
    if (!activePopup || activePopup.resolved) return;

    const entry = activePopup.entry;
    log(`Auto-resolving popup [${entry.entryId}] mode=${mode}`);

    // Kill the popup process
    if (activePopup.process) {
        try { activePopup.process.kill('SIGTERM'); } catch (_) {}
    }

    if (mode === 'allow') {
        // PostToolUse auto-resolve: allow for PermissionRequest, decline for Elicitation
        if (entry.type === 'Elicitation') {
            resolvePopup('SKIP');
        } else {
            resolvePopup('Allow Once');
        }
    } else {
        // SessionEnd or other safe-default
        if (entry.type === 'PermissionRequest') {
            resolvePopup('Allow Once');
        } else if (entry.type === 'Elicitation') {
            resolvePopup('SKIP');
        } else {
            resolvePopup('Allow Once');
        }
    }
}

// ─── Daemon Status ──────────────────────────────────────────────────────────

function writeDaemonStatus() {
    const now = Date.now();
    let oldestAge = 0;

    const allEntries = [...highPriorityQueue, ...lowPriorityQueue];
    if (allEntries.length > 0) {
        const oldest = allEntries.reduce((a, b) => a.enqueuedAt < b.enqueuedAt ? a : b);
        oldestAge = Math.floor((now - oldest.enqueuedAt) / 1000);
    }

    const status = {
        nats: natsStatus,
        queueDepth: highPriorityQueue.length + lowPriorityQueue.length,
        activePopup: activePopup
            ? `${activePopup.entry.type}:${activePopup.entry.tool_name || 'unknown'}`
            : null,
        uptime: Math.floor((now - startTime) / 1000),
        pid: process.pid,
        oldestQueuedEventAge: oldestAge,
        lastHeartbeat: now,
    };

    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
    } catch (e) {
        log(`Failed to write daemon status: ${e.message}`);
    }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function shutdown(signal) {
    log(`Received ${signal}, shutting down...`);

    // Clear all timers
    if (filePollTimer) clearInterval(filePollTimer);
    if (dedupCleanupTimer) clearInterval(dedupCleanupTimer);
    if (queueTimeoutTimer) clearInterval(queueTimeoutTimer);
    if (statusWriteTimer) clearInterval(statusWriteTimer);
    if (natsReconnectTimer) clearInterval(natsReconnectTimer);

    // Close NATS
    if (natsConnection) {
        try {
            await natsConnection.close();
            log('NATS connection closed.');
        } catch (e) {
            log(`Error closing NATS: ${e.message}`);
        }
    }

    // Kill active popup
    if (activePopup && activePopup.process) {
        try { activePopup.process.kill('SIGTERM'); } catch (_) {}
    }

    // Clean up PID file
    cleanupPidFile();

    // Write final status
    writeDaemonStatus();

    log('Daemon shutdown complete.');
    process.exit(0);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    // Singleton check
    ensureDirs();
    checkSingleton();
    killOrphanedPopups();

    // Signal handlers
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        if (err.code === 'EPIPE') return; // ignore broken pipe — stdout/stderr closed
        log(`Uncaught exception: ${err.message}\n${err.stack}`);
    });
    process.on('unhandledRejection', (reason) => {
        log(`Unhandled rejection: ${reason}`);
    });

    // Attempt NATS connection
    const natsConnected = await connectNats();

    if (natsConnected) {
        // NATS connected — drain file queue, poll at slow interval
        await drainFileQueues();
        setFilePollInterval(FILE_POLL_SLOW_MS);
    } else {
        // File-only mode — poll at fast interval
        setFilePollInterval(FILE_POLL_FAST_MS);
        scheduleNatsReconnect();
    }

    // Start dedup cleanup
    dedupCleanupTimer = setInterval(cleanupDedupSet, DEDUP_CLEANUP_INTERVAL_MS);

    // Start queue timeout checker
    queueTimeoutTimer = setInterval(checkQueueTimeouts, QUEUE_TIMEOUT_CHECK_INTERVAL_MS);

    // Start status writer
    writeDaemonStatus();
    statusWriteTimer = setInterval(writeDaemonStatus, STATUS_WRITE_INTERVAL_MS);

    log('Daemon running. NATS=' + natsStatus +
        ' filePollInterval=' + filePollIntervalMs + 'ms');
}

main().catch((err) => {
    log(`Fatal error: ${err.message}\n${err.stack}`);
    cleanupPidFile();
    process.exit(1);
});

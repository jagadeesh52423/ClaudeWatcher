# Hooks Queue Architecture Design

**Date:** 2026-03-24
**Status:** Approved
**Project:** claudeWatcher

---

## Problem Statement

The current architecture opens native popup dialogs directly from `on-claude-notify.sh` on every hook invocation. When multiple Claude Code sessions fire hooks simultaneously, multiple popups open at once — overwhelming the user. Additionally, only 4 of Claude Code's hook types are handled, PostToolUse is missing entirely, and the hook script blocks until the user dismisses each popup.

---

## Goals

1. Handle all relevant Claude Code hook types (12 event types registered; Notification has 4 matchers but is one event type)
2. Queue all incoming hook events — show one popup at a time
3. Use NATS (Docker) as the queue transport, with a layered in-memory + file fallback
4. Use PostToolUse to silently drop queued popups for tools that already ran
5. Hook script exits immediately (~100ms) on every invocation

---

## Non-Goals

- No compiled binary (no Go/Rust build step)
- No HTTP middleware layer between hook script and daemon
- No changes to `popup-gui.js`
- No changes to `claude-watcher` CLI commands or status dashboard format

---

## Architecture Overview

```
Claude Code (hook fires)
        │
        ▼
on-claude-notify.sh          ← thin publisher, exits immediately
        │
        ├─── NATS available ──► publish to "claude.hooks" (high priority)
        │                                   │
        └─── NATS down ───────► write to /tmp/claude-watcher/queue/hooks/<ts>-<sessionid>-<pid>.json
                                            │
                                            ▼
                               popup-daemon.js  (Node.js daemon)
                                    │
                               ┌────┴──────────────────────────────┐
                               │  NATS subscriber                  │
                               │  claude.hooks  (priority 1)       │
                               │  claude.scanner (priority 2)      │
                               │                                   │
                               │  highPriorityQueue[]              │
                               │  lowPriorityQueue[]               │
                               │  File queue (durability fallback) │
                               │                                   │
                               │  pendingReplies Map<id,subject>   │
                               │  PostToolUse → drop all matching  │
                               │  queue entries silently           │
                               │                                   │
                               │  One popup at a time via          │
                               │  popup-gui.js                     │
                               └───────────────────────────────────┘

claude-watcher (scanner)
        └──► publishes to "claude.scanner" (low priority)
             fallback: write to /tmp/claude-watcher/queue/scanner/
```

---

## Component Responsibilities

### `on-claude-notify.sh` — Thin Publisher

- Reads stdin JSON payload from Claude Code
- Parses: `session_id`, `hook_event_name`, `tool_name`, `cwd`
- Builds envelope: `{ type, session_id, tool_name, cwd, timestamp, raw_payload }`
- Publishes to NATS subject `claude.hooks` via a Node.js one-liner (timeout 3s)
- Fallback on NATS failure: writes envelope JSON to `/tmp/claude-watcher/queue/hooks/<timestamp>-<session_id>-<pid>.json` (session_id encoded in filename for fast cleanup)
- All other hooks: fire-and-forget, exit 0 immediately.

**Exception — PermissionRequest (NATS available):**
Includes `replySubject = "claude.reply.<session_id>.<pid>"` in the envelope. After publishing, subscribes to that reply subject (timeout 120s). Daemon processes the popup and publishes its response to the reply subject. Hook script receives the reply, writes JSON to stdout, exits 0. If 120s timeout expires before reply arrives, emits `{ behavior: "allow" }` as safe fallback.

**Exception — PermissionRequest (NATS unavailable):**
Writes envelope to file queue (filename includes session_id). Then polls `/tmp/claude-watcher/reply/<session_id>-<pid>.json` every 500ms for up to 120s. Daemon (in file-queue mode) writes the reply JSON to that file after popup resolution. Hook script reads it and exits. If 120s expires, emits `{ behavior: "allow" }`.

### `popup-daemon.js` — Single Consumer (replaces bash `popup-daemon`)

Internal state:
- `highPriorityQueue[]` — events from `claude.hooks` (PermissionRequest, Elicitation, etc.)
- `lowPriorityQueue[]` — events from `claude.scanner`
- `activePopup` — currently showing event (`null` if idle)
- `pendingReplies: Map<entryId, PendingReply>` — populated at enqueue time for every PermissionRequest event; used to send reply when popup is resolved or entry is dropped
- `alwaysAllowCache: Map<toolName, expiryTimestamp>` — persists for the lifetime of the daemon process (not cleared on SessionEnd); TTL per entry is 5 minutes (300s), checked at each cache lookup

**`entryId` format:** `<session_id>:<tool_name>:<timestamp_ms>:<random_4hex>` — e.g. `abc123:Bash:1711234567890:a3f2`. Assigned by the daemon at enqueue time. Unique across concurrent events.

**`PendingReply` type:**
```
{
  mode: "nats" | "file",
  replySubject: string,   // NATS reply subject (mode == "nats")
  replyFilePath: string,  // /tmp/claude-watcher/reply/<session_id>-<pid>.json (mode == "file")
  enqueuedAt: number      // timestamp_ms, used for 110s queue-age timeout
}
```
The envelope published by the hook script includes both `replySubject` (NATS subject) and `replyFilePath` fields. The daemon populates `PendingReply.mode` based on whether NATS is currently connected at enqueue time.

- `alwaysAllowCache: Map<toolName, expiryTimestamp>` — persists for the lifetime of the daemon process (not cleared on SessionEnd); TTL per entry is 5 minutes (300s), checked at each cache lookup

Responsibilities:
- Subscribe to `claude.hooks` and `claude.scanner` NATS subjects
- Drain and watch `/tmp/claude-watcher/queue/` as durability fallback
- Ensure all required `/tmp/claude-watcher/` subdirectories exist at startup
- Process one popup at a time via `popup-gui.js`
- Handle state-only events (no popup) for lifecycle hooks
- Drop **all** queued entries (both queues) where `tool_name + session_id` match on PostToolUse; for file-queue entries, the daemon reads file content to confirm `tool_name` match before deleting (filename does not encode `tool_name`)
- For each dropped PermissionRequest entry, immediately send reply via `PendingReply.mode`: publish to `replySubject` if NATS, or write to `replyFilePath` if file mode
- Write `/tmp/claude-watcher/daemon-status.json` every 10s for `claude-watcher status`

**Priority queue logic:** After each popup completes (or after each new event arrives), `tryNextPopup()` checks `highPriorityQueue` first — if non-empty, dequeues from it. Only dequeues from `lowPriorityQueue` when `highPriorityQueue` is empty. This is implemented in the daemon, not relying on NATS subject ordering.

### `popup-gui.js` — Unchanged

No changes. Still used by daemon to render native macOS dialogs.

### `claude-watcher` — Updated Scanner Path

Scanner publishes detected states to NATS `claude.scanner` subject instead of writing queue files directly. Fallback remains file-based.

---

## NATS Subjects

| Subject | Priority | Publisher | Content |
|---------|----------|-----------|---------|
| `claude.hooks` | 1 (high) | `on-claude-notify.sh` | Hook events from Claude Code |
| `claude.scanner` | 2 (low) | `claude-watcher` scanner | Scanner-detected session states |

Priority is enforced by the daemon's two-queue internal model, not by NATS itself.

---

## Hook Registrations

12 event types are registered (Notification has 4 matchers but counts as one event type):

| Hook | Matcher | Action in Daemon |
|------|---------|-----------------|
| `PermissionRequest` | `""` (all) | Show Allow/Deny popup, send reply |
| `Elicitation` | `""` (all) | Show options/free-text popup |
| `PreToolUse` | `""` (all) | Update session state → `working` |
| `PostToolUse` | `""` (all) | Drop **all** matching queue entries + session state → `working` |
| `PostToolUseFailure` | `""` (all) | Update session state → `error` |
| `Stop` | `""` (all) | Update session state → `idle` |
| `SessionEnd` | `""` (all) | Flush all queued events for session, state → `done` |
| `UserPromptSubmit` | `""` (all) | Update session state → `working` |
| `SubagentStart` | `""` (all) | Update session state → `working (subagent)` |
| `SubagentStop` | `""` (all) | Update session state → `working` |
| `TeammateIdle` | `""` (all) | Update session state → `needs-attention` |
| `TaskCompleted` | `""` (all) | Update session state → `completed` |
| `Notification` | `permission_prompt` | macOS notification |
| `Notification` | `idle_prompt` | macOS notification (once per idle) |
| `Notification` | `elicitation_dialog` | macOS notification |
| `Notification` | `auth_success` | macOS notification |

---

## Data Flow: PermissionRequest (NATS path)

```
1. Claude Code fires PermissionRequest
2. on-claude-notify.sh builds envelope with replySubject = "claude.reply.<session_id>.<pid>"
3. Publishes to claude.hooks, then subscribes to replySubject (timeout 120s)
4. Daemon receives event, assigns entryId, stores replySubject in pendingReplies[entryId]
5. Enqueues to highPriorityQueue[]
6. When it's this event's turn: daemon shows popup via popup-gui.js
7. User clicks Allow Once / Always Allow / Deny
8. Daemon builds response JSON, publishes to pendingReplies[entryId] (the reply subject)
9. Hook script receives reply, writes JSON to stdout, exits 0
```

---

## Data Flow: PermissionRequest (File-fallback path)

```
1. Claude Code fires PermissionRequest
2. on-claude-notify.sh: NATS publish fails → writes envelope file
   (filename: <ts>-<session_id>-<pid>.json, contains replySubject field)
3. Hook script polls /tmp/claude-watcher/reply/<session_id>-<pid>.json every 500ms
4. Daemon (file-poll mode) reads envelope file, assigns entryId, stores reply path
5. Daemon shows popup, user resolves
6. Daemon writes response JSON to /tmp/claude-watcher/reply/<session_id>-<pid>.json
7. Hook script detects file, reads it, writes to stdout, exits 0
8. Daemon deletes reply file after 30s TTL (no "confirmed read" mechanism — TTL is sufficient)

**Known race:** If SessionEnd fires and deletes reply files while a PermissionRequest hook is still mid-poll, the hook will poll to its 120s timeout and emit `allow`. This is an accepted safe-fallback degraded path — the session is ending anyway.
```

---

## PostToolUse Drop Logic

PostToolUse drop removes **all** matching entries (same `tool_name` + `session_id`) from both queues — multiple queued PermissionRequests for the same tool within one session are all cancelled.

```
Case 1: PostToolUse arrives before popup is shown
  → remove ALL entries from highPriorityQueue[] + lowPriorityQueue[]
    where tool_name + session_id match
  → for each dropped PermissionRequest entry: look up pendingReplies[entryId],
    send { behavior: "allow" } via PendingReply.mode (NATS subject or reply file)
  → for file-queue entries: read file content to confirm tool_name match, then delete

Case 2: PostToolUse arrives while popup is actively showing
  → do NOT forcibly dismiss (jarring UX)
  → flag activePopup.autoResolvable = true
  → on user dismiss OR after 5s timeout → resolve as "allow" automatically

Case 3: PostToolUse arrives after reply already sent
  → no-op (pendingReplies[entryId] already removed)
```

---

## NATS Connection Management

### Daemon Startup

```
0. Ensure /tmp/claude-watcher/ subdirectories exist:
   queue/hooks/, queue/scanner/, session-state/, always-allow/, reply/

1. Attempt NATS connect to nats://localhost:4222 (3 retries, 2s apart)
2a. Success → subscribe to claude.hooks + claude.scanner
              drain existing file queue → enqueue
              watch queue dirs via fs.watch
2b. Failure → log "NATS unavailable, file-queue-only mode"
              poll queue dirs every 2s
              poll reply/ dir for response delivery
              retry NATS connect every 30s in background
```

### Mid-Run Disconnect

- Switch to file queue polling and file-based reply delivery
- Retry NATS reconnect every 30s
- In-memory queues continue processing uninterrupted
- Existing `pendingReplies` entries for in-flight PermissionRequests switch to file mode: daemon writes to `PendingReply.replyFilePath` for any subsequent replies

### Hook Script Publishing

```bash
timeout 3 node -e "publish to NATS" <<< "$envelope" \
  || echo "$envelope" > "/tmp/claude-watcher/queue/hooks/$(date +%s%N)-${session_id}-$$.json"
```

3s timeout ensures hook script never hangs on slow Node startup.

---

## SessionEnd Cleanup

```
SessionEnd fires for session_id X:
  → remove all highPriorityQueue[] + lowPriorityQueue[] entries where session_id == X
  → for each dropped PermissionRequest: send { behavior: "allow" } via pendingReplies
  → delete all /tmp/claude-watcher/queue/hooks/*-X-*.json files
    (session_id is encoded in filename — no content read required)
  → delete all /tmp/claude-watcher/reply/X-*.json files
  → if activePopup.session_id == X:
      → mark autoResolvable = true, resolve "allow" after 2s (not 5s — session is gone)
  → delete /tmp/claude-watcher/session-state/X
  NOTE: always-allow cache is NOT cleared on SessionEnd — it is intentionally
        persistent across sessions (user said "always allow", that should stick)
```

---

## Timeout Handling

| Scenario | Timeout | Fallback |
|----------|---------|----------|
| Hook script waits for PermissionRequest reply | 120s | emit `{ behavior: "allow" }` |
| PermissionRequest sits in queue too long (NATS or file mode) | 110s | daemon auto-resolves `allow`, sends reply via PendingReply.mode (10s buffer before hook's 120s) |
| PostToolUse arrives while popup active | 5s | auto-resolve `allow` and dismiss |
| SessionEnd arrives while popup active | 2s | auto-resolve `allow` and dismiss |
| NATS publish in hook script | 3s | write to file queue |
| osascript popup call | 120s (via `timeout` cmd) | treat as `allow` (safe default, consistent with all other timeouts) |
| Reply file TTL (file-fallback mode) | 30s | daemon deletes stale reply files |

---

## Daemon Health & Status

Daemon writes `/tmp/claude-watcher/daemon-status.json` every 10s:

```json
{
  "nats": "connected | disconnected | file-only",
  "queueDepth": 3,
  "activePopup": "PermissionRequest:Bash",
  "uptime": 3600,
  "pid": 12345,
  "oldestQueuedEventAge": 12
}
```

`queueDepth` is the combined total of `highPriorityQueue.length + lowPriorityQueue.length` (excludes the active popup).
`oldestQueuedEventAge` is the age in seconds of the oldest item across both queues (0 if queues are empty). This surfaces queue stalls in `claude-watcher status`.

`claude-watcher status` reads this file to show NATS connection state alongside session states.

---

## File Structure

```
ClaudeWatcher/
├── on-claude-notify.sh       ← rewritten: thin publisher
├── popup-daemon.js           ← new: replaces popup-daemon (bash)
├── popup-gui.js              ← unchanged
├── claude-watcher            ← updated: scanner publishes to NATS
└── package.json              ← new: { "dependencies": { "nats": "^2.x" } }

/tmp/claude-watcher/
├── queue/
│   ├── hooks/                ← fallback durability for hook events
│   │   └── <ts>-<sessionid>-<pid>.json
│   └── scanner/              ← fallback durability for scanner events
├── reply/                    ← new: file-based reply delivery (NATS fallback)
│   └── <session_id>-<pid>.json
├── session-state/            ← unchanged
├── always-allow/             ← managed by daemon (persistent, not per-session)
├── daemon-status.json        ← new: written every 10s by daemon
├── watcher.log
└── payloads.log
```

All subdirectories under `/tmp/claude-watcher/` are created by the daemon at startup if absent.

---

## Testing Plan

### 1. NATS Publish / Fallback

- Start daemon with NATS running → verify events appear via `nats sub claude.hooks`
- Stop Docker NATS → fire hook → verify file written to `queue/hooks/` with session_id in filename
- Restart NATS → verify daemon reconnects and drains file queue

### 2. Queue Serialization

- Simulate 5 simultaneous PermissionRequest events via `echo '...' | ./on-claude-notify.sh`
- Verify only one popup at a time, others queue
- Verify `claude.hooks` events are shown before `claude.scanner` events

### 3. PostToolUse Drop — Pre-popup

- Queue two PermissionRequests for `Bash` (same session_id)
- Before popup shows, fire PostToolUse for `Bash` (same session_id)
- Verify: both queue entries dropped, both reply subjects receive `allow`, no popup shown

### 4. PostToolUse Drop — Active Popup

- Queue a PermissionRequest for `Bash`, let popup appear
- Fire PostToolUse for `Bash` (same session_id) while popup is showing
- Verify: popup auto-resolves `allow` within 5s without user interaction

### 5. PermissionRequest Reply Flow (NATS)

- Fire PermissionRequest via hook, verify hook script blocks waiting for reply
- Daemon shows popup → click Allow Once → verify correct JSON on stdout
- Verify hook exits within expected time

### 6. PermissionRequest Reply Flow (File Fallback)

- Stop Docker NATS
- Fire PermissionRequest → verify envelope written to file queue
- Verify daemon reads file, shows popup, writes reply file
- Verify hook script reads reply file and exits with correct JSON

### 7. Session Lifecycle

- Start Claude session, run several tools
- Verify state transitions: `working` → `idle` → `working` → `idle`
- Fire SessionEnd → verify queue cleared, session state removed, always-allow cache retained

### 8. Multi-Session

- Open 3 Claude sessions, trigger PermissionRequests simultaneously
- Verify: one popup at a time, all eventually resolved, no cross-session contamination

### 9. Regression: Scanner Path

- Start daemon without hooks installed (scanner-only mode)
- Verify scanner events publish to `claude.scanner`, popups still show

### 10. NATS Unavailable End-to-End

- Start daemon with Docker NATS stopped
- Fire multiple hooks → verify file fallback works end-to-end
- Bring NATS back → verify reconnect and file queue drain

### 11. Timeout / Edge Cases

- Fire PermissionRequest, do not interact with popup — verify daemon auto-resolves at 110s and hook script exits with `allow` before its own 120s timer
- Fire PermissionRequest during NATS outage, do not interact — verify hook script emits `allow` after 120s polling timeout
- Fire SessionEnd while PermissionRequest popup is active — verify popup auto-resolves `allow` within 2s
- Simulate osascript hang (wrap with short timeout) — verify fallback is `allow` not `Deny`

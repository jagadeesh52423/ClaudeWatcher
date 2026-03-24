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
                               │  pendingReplies Map<id, reply>    │
                               │  recentEventIds Set (dedup)       │
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
- Generates `eventId = <session_id>:<pid>:<timestamp_ms>` for deduplication
- Builds envelope: `{ eventId, type, session_id, tool_name, cwd, hookLaunchTimestamp, raw_payload }`
  - `hookLaunchTimestamp` = milliseconds since epoch when the hook script started (used by daemon for timeout computation)
- Publishes to NATS subject `claude.hooks` via a Node.js one-liner (timeout 3s)
- Fallback on NATS failure: writes envelope JSON to `/tmp/claude-watcher/queue/hooks/<timestamp_ms>-<session_id>-<pid>.json`
  - **Note:** `timestamp_ms` is generated via `node -e "process.stdout.write(String(Date.now()))"` because macOS `date` does not support `%N` (nanoseconds)
- All other hooks: fire-and-forget, exit 0 immediately.

**Exception — PermissionRequest and Elicitation (blocking hooks):**
Both PermissionRequest and Elicitation require responses back to Claude Code. They use the same reply pattern:

1. Envelope includes `replySubject = "claude.reply.<session_id>.<pid>"` and `replyFilePath = "/tmp/claude-watcher/reply/<session_id>-<pid>.json"`
2. **NATS available:** After publishing to `claude.hooks`, hook script enters a dual-wait loop:
   - Primary: subscribe to `replySubject` on NATS
   - Secondary: poll `replyFilePath` every 5s as safety net (covers NATS mid-disconnect)
   - First to return wins. Timeout: 120s total.
3. **NATS unavailable:** Writes envelope to file queue, then polls `replyFilePath` every 500ms for up to 120s.
4. If 120s timeout expires before reply arrives, emits safe fallback response:
   - PermissionRequest: `{ behavior: "allow" }`
   - Elicitation: `{ action: "decline" }` (decline the MCP input request)

### `popup-daemon.js` — Single Consumer (replaces bash `popup-daemon`)

**Singleton enforcement:** At startup, writes PID to `/tmp/claude-watcher/daemon.pid`. If PID file exists and process is alive (`kill -0`), refuse to start. On shutdown, delete PID file.

Internal state:
- `highPriorityQueue[]` — events from `claude.hooks` (PermissionRequest, Elicitation, etc.)
- `lowPriorityQueue[]` — events from `claude.scanner`
- `activePopup` — currently showing event (`null` if idle)
- `pendingReplies: Map<entryId, PendingReply>` — populated at enqueue time for every PermissionRequest and Elicitation event; used to send reply when popup is resolved or entry is dropped
- `alwaysAllowCache: Map<toolName, expiryTimestamp>` — 5-minute (300s) convenience TTL per entry, checked at each lookup. "Always Allow" means "don't ask again for 5 minutes" (matches current behavior). Persists for daemon lifetime, not cleared on SessionEnd.
- `recentEventIds: Set<string>` — stores eventIds seen in the last 60s for deduplication. Entries cleaned up every 30s.

**`entryId` format:** `<session_id>:<tool_name>:<timestamp_ms>:<random_4hex>` — e.g. `abc123:Bash:1711234567890:a3f2`. Assigned by the daemon at enqueue time. Unique across concurrent events.

**`PendingReply` type:**
```
{
  deliveryChannel: "nats" | "file",  // how the event ARRIVED at the daemon
  replySubject: string,              // NATS reply subject (always populated from envelope)
  replyFilePath: string,             // /tmp/claude-watcher/reply/<session_id>-<pid>.json (always populated)
  hookLaunchTimestamp: number         // from envelope, used for timeout computation
}
```

`deliveryChannel` is set based on **how the event arrived at the daemon** (not the daemon's current NATS state):
- Event arrived via NATS subscription → `deliveryChannel: "nats"`
- Event arrived via file queue poll → `deliveryChannel: "file"`

**Reply delivery strategy (covers NATS mid-disconnect):**
When sending a reply, the daemon:
1. If `deliveryChannel == "nats"`: attempt NATS publish to `replySubject`. If NATS publish fails, fall back to writing `replyFilePath`.
2. If `deliveryChannel == "file"`: write to `replyFilePath`.
3. This ensures the reply is always deliverable — the hook script's dual-wait (NATS primary + file secondary) will catch it either way.

Responsibilities:
- Subscribe to `claude.hooks` and `claude.scanner` NATS subjects
- Drain and watch `/tmp/claude-watcher/queue/` as durability fallback (use `fs.readdir` polling every 1s in file-only mode for reliability, not `fs.watch` which is unreliable on macOS FSEvents)
- Ensure all required `/tmp/claude-watcher/` subdirectories exist at startup
- Deduplicate: on enqueue, check `recentEventIds` — if `eventId` was already seen, skip the event
- Process one popup at a time via `popup-gui.js`
- Handle state-only events (no popup) for lifecycle hooks
- Drop **all** queued entries (both queues) where `tool_name + session_id` match on PostToolUse; for file-queue entries, the daemon reads file content to confirm `tool_name` match before deleting (filename does not encode `tool_name`)
- For each dropped PermissionRequest/Elicitation entry, immediately send reply via the reply delivery strategy above
- Write `/tmp/claude-watcher/daemon-status.json` every 10s for `claude-watcher status`

**Priority queue logic:** After each popup completes (or after each new event arrives), `tryNextPopup()` checks `highPriorityQueue` first — if non-empty, dequeues from it. Only dequeues from `lowPriorityQueue` when `highPriorityQueue` is empty.

**Starvation prevention:** If the oldest item in `lowPriorityQueue` has been queued for more than 60s, it is promoted to the front of `highPriorityQueue`. This prevents indefinite starvation of scanner events during heavy hook traffic.

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
| `PermissionRequest` | `""` (all) | Show Allow/Deny popup, send reply (blocking hook) |
| `Elicitation` | `""` (all) | Show options/free-text popup, send reply (blocking hook) |
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

## Data Flow: Blocking Hooks — PermissionRequest & Elicitation

Both PermissionRequest and Elicitation use the same reply pattern. The only difference is the popup type shown and the response JSON format.

### NATS Path

```
1. Claude Code fires hook (PermissionRequest or Elicitation)
2. on-claude-notify.sh builds envelope with:
   - eventId = "<session_id>:<pid>:<timestamp_ms>"
   - replySubject = "claude.reply.<session_id>.<pid>"
   - replyFilePath = "/tmp/claude-watcher/reply/<session_id>-<pid>.json"
   - hookLaunchTimestamp = Date.now()
3. Publishes to claude.hooks
4. Enters dual-wait loop:
   - NATS: subscribe to replySubject
   - File: poll replyFilePath every 5s (safety net for mid-disconnect)
   - 120s total timeout
5. Daemon receives event via NATS → sets deliveryChannel = "nats"
6. Dedup check: if eventId in recentEventIds, skip. Otherwise add to set and enqueue.
7. Assigns entryId, stores PendingReply in pendingReplies[entryId]
8. When it's this event's turn: daemon shows popup via popup-gui.js
9. User interacts → daemon builds response JSON
10. Reply delivery: attempt NATS publish to replySubject; if fails, write replyFilePath
11. Hook script receives reply (NATS sub or file poll), writes JSON to stdout, exits 0
```

### File-Fallback Path

```
1. Claude Code fires hook
2. on-claude-notify.sh: NATS publish fails → writes envelope file
   (filename: <ts_ms>-<session_id>-<pid>.json)
3. Hook script polls /tmp/claude-watcher/reply/<session_id>-<pid>.json every 500ms
4. Daemon polls queue dir, reads envelope → sets deliveryChannel = "file"
5. Dedup check, enqueue, assign entryId, store PendingReply
6. Daemon shows popup, user resolves
7. Daemon writes response JSON to replyFilePath
8. Hook script detects file, reads it, writes to stdout, exits 0
9. Daemon deletes reply file after 30s TTL

**Known race:** If SessionEnd deletes reply files while a hook is mid-poll,
the hook polls to 120s timeout and emits safe fallback. Accepted degraded path.
```

### Reply JSON Formats

**PermissionRequest reply:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": []
    }
  }
}
```
(Or `"behavior": "deny"` with optional `"message"`)

**Elicitation reply:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "accept",
    "response": {
      "selectedOption": "option_label"
    }
  }
}
```
(Or `"action": "decline"` to skip, or `"action": "cancel"` to abort)

For free-text elicitation:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "accept",
    "response": {
      "text": "user typed this"
    }
  }
}
```

---

## PostToolUse Drop Logic

**Semantic model:** Claude Code's PermissionRequest hook is blocking — the tool does NOT execute until the hook replies. Therefore, a PostToolUse for tool X means a *previous* invocation of X completed. The drop logic removes queued PermissionRequests for *other pending* invocations of the same tool name in the same session. This is safe because it is equivalent to the always-allow pattern — if tool X was just allowed and completed successfully, the next queued permission for X can be auto-allowed.

PostToolUse drop removes **all** matching entries (same `tool_name` + `session_id`) from both queues.

```
Case 1: PostToolUse arrives before popup is shown
  → remove ALL entries from highPriorityQueue[] + lowPriorityQueue[]
    where tool_name + session_id match
  → for each dropped entry with pendingReplies: send safe-default reply
    (PermissionRequest: allow; Elicitation: decline)
    via reply delivery strategy (NATS first, file fallback)
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
0. Singleton check: if /tmp/claude-watcher/daemon.pid exists and process alive → exit
   Write own PID to /tmp/claude-watcher/daemon.pid
   Kill any orphaned osascript processes matching popup-gui.js

1. Ensure /tmp/claude-watcher/ subdirectories exist:
   queue/hooks/, queue/scanner/, session-state/, always-allow/, reply/

2. Attempt NATS connect to nats://localhost:4222 (3 retries, 2s apart)
3a. Success → subscribe to claude.hooks + claude.scanner
              drain existing file queue → enqueue (with dedup)
              start fs.readdir polling on queue dirs every 5s (durability safety net)
3b. Failure → log "NATS unavailable, file-queue-only mode"
              poll queue dirs via fs.readdir every 1s
              retry NATS connect every 30s in background
```

### Mid-Run Disconnect

- Log "NATS disconnected, switching to file-queue mode"
- Start polling queue dirs via `fs.readdir` every 1s
- Retry NATS reconnect every 30s
- In-memory queues continue processing uninterrupted
- Reply delivery automatically handles this: NATS publish fails → write reply file instead

### Mid-Run Reconnect

- Log "NATS reconnected"
- Re-subscribe to `claude.hooks` and `claude.scanner`
- Drain any file queue entries accumulated during outage
- Reduce file polling to 5s (safety net only)

### Hook Script Publishing

```bash
# Generate timestamp via Node (macOS date doesn't support %N)
_ts=$(node -e "process.stdout.write(String(Date.now()))")
timeout 3 node -e "...publish to NATS..." <<< "$envelope" \
  || echo "$envelope" > "/tmp/claude-watcher/queue/hooks/${_ts}-${session_id}-$$.json"
```

3s timeout ensures hook script never hangs on slow Node startup.

---

## SessionEnd Cleanup

```
SessionEnd fires for session_id X:
  → remove all highPriorityQueue[] + lowPriorityQueue[] entries where session_id == X
  → for each dropped entry with pendingReplies: send safe-default reply
  → delete all /tmp/claude-watcher/queue/hooks/*-X-*.json files
    (session_id is encoded in filename — no content read required)
  → delete all /tmp/claude-watcher/reply/X-*.json files
  → if activePopup.session_id == X:
      → mark autoResolvable = true, resolve safe-default after 2s (session is gone)
  → delete /tmp/claude-watcher/session-state/X
  NOTE: always-allow cache is NOT cleared on SessionEnd
```

---

## Crash Recovery

If the daemon crashes or is killed:

1. **In-memory queues are lost.** File queue entries are the durability layer — they are only deleted after successful processing/reply delivery. On restart, the daemon drains existing file queue entries. Events that were already in-memory but not yet in file queue are lost (this is acceptable — they will time out on the hook side with safe defaults).

2. **`pendingReplies` map is lost.** In-flight PermissionRequest/Elicitation hook scripts will continue waiting until their 120s timeout, then emit safe fallback responses (`allow` / `decline`). This is the correct degraded behavior.

3. **Orphaned popup processes.** On startup, the daemon kills any orphaned `osascript` processes whose command line includes `popup-gui.js`: `pkill -f "popup-gui.js"`.

4. **Stale daemon PID file.** On startup, if `/tmp/claude-watcher/daemon.pid` exists but the process is not alive, the daemon overwrites it and proceeds.

5. **Dead daemon detection.** `daemon-status.json` includes a `lastHeartbeat` timestamp. `claude-watcher status` checks if `lastHeartbeat` is older than 30s — if so, reports daemon as dead.

---

## Timeout Handling

| Scenario | Timeout | Fallback |
|----------|---------|----------|
| Hook script waits for reply (dual-wait) | 120s wall-clock from hook launch | emit safe default (`allow` / `decline`) |
| Event sits in daemon queue too long | `hookLaunchTimestamp + 105s` | daemon auto-resolves with safe default, sends reply (15s buffer before hook's 120s) |
| PostToolUse arrives while popup active | 5s | auto-resolve `allow` and dismiss |
| SessionEnd arrives while popup active | 2s | auto-resolve safe default and dismiss |
| NATS publish in hook script | 3s | write to file queue |
| osascript popup call | 120s (via `timeout` cmd) | treat as `allow` (safe default) |
| Reply file TTL (file-fallback mode) | 30s | daemon deletes stale reply files |
| Dedup eventId TTL | 60s | entries cleaned from `recentEventIds` every 30s |

**Timeout computation note:** The daemon computes auto-resolve deadline from `hookLaunchTimestamp` (included in the envelope), NOT from `enqueuedAt`. This guarantees the 15s buffer regardless of delays between hook launch and daemon enqueue.

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
  "oldestQueuedEventAge": 12,
  "lastHeartbeat": 1711234567890
}
```

`queueDepth` is the combined total of `highPriorityQueue.length + lowPriorityQueue.length` (excludes the active popup).
`oldestQueuedEventAge` is the age in seconds of the oldest item across both queues (0 if queues are empty). Surfaces queue stalls.
`lastHeartbeat` is epoch ms. `claude-watcher status` checks if older than 30s → reports daemon as dead.

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
│   │   └── <ts_ms>-<sessionid>-<pid>.json
│   └── scanner/              ← fallback durability for scanner events
├── reply/                    ← file-based reply delivery
│   └── <session_id>-<pid>.json
├── session-state/            ← unchanged
├── always-allow/             ← managed by daemon (5-min TTL per entry)
├── daemon.pid                ← singleton enforcement
├── daemon-status.json        ← health/status (written every 10s)
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

- Fire PermissionRequest via hook, verify hook script blocks on dual-wait
- Daemon shows popup → click Allow Once → verify correct JSON on stdout
- Verify hook exits within expected time

### 6. PermissionRequest Reply Flow (File Fallback)

- Stop Docker NATS
- Fire PermissionRequest → verify envelope written to file queue
- Verify daemon reads file, shows popup, writes reply file
- Verify hook script reads reply file and exits with correct JSON

### 7. Elicitation Reply Flow (NATS + File)

- Fire Elicitation with options → verify popup shows options
- Select an option → verify correct `hookSpecificOutput` JSON with `action: "accept"` on stdout
- Fire Elicitation without NATS → verify file-fallback reply works

### 8. Session Lifecycle

- Start Claude session, run several tools
- Verify state transitions: `working` → `idle` → `working` → `idle`
- Fire SessionEnd → verify queue cleared, session state removed, always-allow cache retained

### 9. Multi-Session

- Open 3 Claude sessions, trigger PermissionRequests simultaneously
- Verify: one popup at a time, all eventually resolved, no cross-session contamination

### 10. Regression: Scanner Path

- Start daemon without hooks installed (scanner-only mode)
- Verify scanner events publish to `claude.scanner`, popups still show

### 11. NATS Unavailable End-to-End

- Start daemon with Docker NATS stopped
- Fire multiple hooks → verify file fallback works end-to-end
- Bring NATS back → verify reconnect and file queue drain

### 12. Timeout / Edge Cases

- Fire PermissionRequest, do not interact with popup — verify daemon auto-resolves at `hookLaunchTimestamp + 105s` and hook script exits with `allow` before its own 120s timer
- Fire PermissionRequest during NATS outage, do not interact — verify hook script emits `allow` after 120s polling timeout
- Fire SessionEnd while PermissionRequest popup is active — verify popup auto-resolves `allow` within 2s
- Simulate osascript hang (wrap with short timeout) — verify fallback is `allow`

### 13. NATS Mid-Disconnect During PermissionRequest

- Fire PermissionRequest via NATS (hook script enters dual-wait)
- Kill Docker NATS while popup is queued
- Daemon shows popup, user clicks Allow
- Verify: NATS reply fails, daemon writes reply file, hook script picks it up via file poll (5s interval)

### 14. Deduplication

- Simulate a race: publish same event to NATS AND write to file queue (same eventId)
- Verify daemon only enqueues and processes it once

### 15. Crash Recovery

- Start daemon, enqueue several events to file queue
- Kill daemon process (kill -9)
- Restart daemon → verify file queue is drained, orphaned osascript killed, singleton PID updated

### 16. Starvation Prevention

- Flood `claude.hooks` with state-only events continuously
- Queue a scanner event on `claude.scanner`
- Verify scanner event is promoted after 60s and eventually processed

### 17. Daemon Health

- Start daemon → verify `daemon-status.json` updates every 10s with correct fields
- Kill daemon → verify `claude-watcher status` detects stale `lastHeartbeat`

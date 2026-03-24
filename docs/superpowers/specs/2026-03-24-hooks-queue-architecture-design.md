# Hooks Queue Architecture Design

**Date:** 2026-03-24
**Status:** Approved
**Project:** claudeWatcher

---

## Problem Statement

The current architecture opens native popup dialogs directly from `on-claude-notify.sh` on every hook invocation. When multiple Claude Code sessions fire hooks simultaneously, multiple popups open at once — overwhelming the user. Additionally, only 4 of Claude Code's hook types are handled, PostToolUse is missing entirely, and the hook script blocks until the user dismisses each popup.

---

## Goals

1. Handle all relevant Claude Code hook types (14 total, up from 4)
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
        └─── NATS down ───────► write to /tmp/claude-watcher/queue/hooks/<ts>-<pid>.json
                                            │
                                            ▼
                               popup-daemon.js  (Node.js daemon)
                                    │
                               ┌────┴──────────────────────────────┐
                               │  NATS subscriber                  │
                               │  claude.hooks  (priority 1)       │
                               │  claude.scanner (priority 2)      │
                               │                                   │
                               │  In-memory queue[]                │
                               │  File queue (durability fallback) │
                               │                                   │
                               │  PostToolUse → drop matching      │
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
- Fallback on NATS failure: writes envelope JSON to `/tmp/claude-watcher/queue/hooks/<timestamp>-<pid>.json`
- **Exception — PermissionRequest:** must wait for a reply from the daemon before writing response to stdout. Subscribes to reply subject `claude.reply.<session_id>.<pid>`, waits up to 120s, then exits with the resolved JSON. If timeout, emits `{ behavior: "allow" }` as safe fallback.
- All other hooks: fire-and-forget, exit 0 immediately.

### `popup-daemon.js` — Single Consumer (replaces bash `popup-daemon`)

Responsibilities:
- Subscribe to `claude.hooks` and `claude.scanner` NATS subjects
- Maintain an in-memory queue array as primary store
- Drain and watch `/tmp/claude-watcher/queue/` as durability fallback
- Process one popup at a time via `popup-gui.js`
- Handle state-only events (no popup) for lifecycle hooks
- Drop queued PermissionRequest entries when PostToolUse fires for the same tool+session
- Manage always-allow cache (moved from hook script)
- Write `/tmp/claude-watcher/daemon-status.json` every 10s for `claude-watcher status`

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

When both subjects have pending messages, daemon drains `claude.hooks` first.

---

## Hook Registrations

All 14 hooks point to the same `on-claude-notify.sh` script:

| Hook | Matcher | Action in Daemon |
|------|---------|-----------------|
| `PermissionRequest` | `""` (all) | Show Allow/Deny popup, send reply |
| `Elicitation` | `""` (all) | Show options/free-text popup |
| `PreToolUse` | `""` (all) | Update session state → `working` |
| `PostToolUse` | `""` (all) | Drop matching queue entries + state → `working` |
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

## Data Flow: PermissionRequest (Reply Pattern)

```
1. Claude Code fires PermissionRequest
2. on-claude-notify.sh builds envelope with replySubject = "claude.reply.<session_id>.<pid>"
3. Publishes to claude.hooks, subscribes to replySubject (timeout 120s)
4. Daemon receives event, enqueues it
5. When it's this event's turn: daemon shows popup via popup-gui.js
6. User clicks Allow Once / Always Allow / Deny
7. Daemon builds response JSON, publishes to replySubject
8. Hook script receives reply, writes JSON to stdout, exits 0
```

If PostToolUse for the same tool+session arrives before the popup is shown:
- Queue entry is dropped silently
- Daemon immediately publishes `{ behavior: "allow" }` to replySubject
- Hook script unblocked, Claude Code proceeds

---

## PostToolUse Drop Logic

```
Case 1: PostToolUse arrives before popup is shown
  → remove from inMemoryQueue[] where tool_name + session_id match
  → delete corresponding file from queue/hooks/ if present
  → publish { behavior: "allow" } to pendingReply immediately

Case 2: PostToolUse arrives while popup is actively showing
  → do NOT forcibly dismiss (jarring UX)
  → flag activePopup.autoResolvable = true
  → on dismiss OR after 5s timeout → resolve as "allow" automatically

Case 3: PostToolUse arrives after reply already sent
  → no-op
```

---

## NATS Connection Management

### Daemon Startup

```
1. Attempt NATS connect to nats://localhost:4222 (3 retries, 2s apart)
2a. Success → subscribe to claude.hooks + claude.scanner
              drain existing file queue → enqueue
              watch queue dirs via fs.watch
2b. Failure → log "NATS unavailable, file-queue-only mode"
              poll queue dirs every 2s
              retry NATS connect every 30s in background
```

### Mid-Run Disconnect

- Switch to file queue polling
- Retry NATS reconnect every 30s
- In-memory queue continues processing uninterrupted

### Hook Script Publishing

```bash
timeout 3 node -e "publish to NATS" <<< "$envelope" \
  || echo "$envelope" > "/tmp/claude-watcher/queue/hooks/$(date +%s%N)-$$.json"
```

3s timeout ensures hook script never hangs on slow Node startup.

---

## SessionEnd Cleanup

```
SessionEnd fires for session_id X:
  → remove all inMemoryQueue[] entries where session_id == X
  → delete all /tmp/claude-watcher/queue/hooks/*-X-*.json files
  → if activePopup.session_id == X → mark autoResolvable, resolve in 5s
  → delete /tmp/claude-watcher/session-state/X
  → remove always-allow cache entries scoped to session X
```

---

## Timeout Handling

| Scenario | Timeout | Fallback |
|----------|---------|----------|
| Hook script waits for PermissionRequest reply | 120s | emit `{ behavior: "allow" }` |
| PermissionRequest sits in queue too long | 90s | daemon auto-resolves `allow`, sends reply |
| PostToolUse arrives while popup active | 5s | auto-resolve `allow` and dismiss |
| NATS publish in hook script | 3s | write to file queue |
| osascript popup call | 120s (via timeout cmd) | treat as Deny |

---

## Daemon Health & Status

Daemon writes `/tmp/claude-watcher/daemon-status.json` every 10s:

```json
{
  "nats": "connected | disconnected | file-only",
  "queueDepth": 3,
  "activePopup": "PermissionRequest:Bash",
  "uptime": 3600,
  "pid": 12345
}
```

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
│   └── scanner/              ← fallback durability for scanner events
├── session-state/            ← unchanged
├── always-allow/             ← managed by daemon (not hook script)
├── daemon-status.json        ← new: written every 10s by daemon
├── watcher.log
└── payloads.log
```

---

## Testing Plan

### 1. NATS Publish / Fallback

- Start daemon with NATS running → verify events appear via `nats sub claude.hooks`
- Stop Docker NATS → fire hook → verify file written to `queue/hooks/`
- Restart NATS → verify daemon reconnects and drains file queue

### 2. Queue Serialization

- Simulate 5 simultaneous PermissionRequest events via `echo '...' | ./on-claude-notify.sh`
- Verify only one popup at a time, others queue
- Verify `claude.hooks` events are shown before `claude.scanner` events

### 3. PostToolUse Drop

- Queue a PermissionRequest for `Bash`
- Before popup shows, fire PostToolUse for `Bash` (same session_id)
- Verify: queue entry dropped, reply subject receives `allow`, no popup shown

### 4. PermissionRequest Reply Flow

- Fire PermissionRequest via hook, verify hook script blocks waiting for reply
- Daemon shows popup → click Allow Once → verify correct JSON on stdout
- Verify hook exits within expected time

### 5. Session Lifecycle

- Start Claude session, run several tools
- Verify state transitions: `working` → `idle` → `working` → `idle`
- Fire SessionEnd → verify queue cleared, session state removed

### 6. Multi-Session

- Open 3 Claude sessions, trigger PermissionRequests simultaneously
- Verify: one popup at a time, all resolved, no cross-session contamination

### 7. Regression: Scanner Path

- Start daemon without hooks installed (scanner-only mode)
- Verify scanner events publish to `claude.scanner`, popups still show

### 8. NATS Unavailable

- Start daemon with Docker NATS stopped
- Fire hooks → verify file fallback works end-to-end
- Bring NATS back → verify reconnect and queue drain

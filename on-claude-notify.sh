#!/usr/bin/env bash
#
# on-claude-notify.sh — Thin NATS publisher for Claude Code hooks
#
# Reads JSON payload from stdin, builds an envelope, publishes to NATS
# subject "claude.hooks" (with file-queue fallback), and exits immediately.
#
# Exception: PermissionRequest and Elicitation are blocking hooks —
# they wait up to 120s for a reply from the popup daemon before exiting.
#
# Part of the claudeWatcher queue architecture.
# See: docs/superpowers/specs/2026-03-24-hooks-queue-architecture-design.md
#

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────

STATE_DIR="/tmp/claude-watcher"
LOG_FILE="$STATE_DIR/watcher.log"
ACTIVE_FILE="$STATE_DIR/active"
QUEUE_DIR="$STATE_DIR/queue/hooks"
REPLY_DIR="$STATE_DIR/reply"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NATS_PUBLISH_TIMEOUT=3        # seconds — timeout for NATS publish
BLOCKING_REPLY_TIMEOUT=120    # seconds — max wait for blocking hook reply
FILE_POLL_INTERVAL_NATS=5     # seconds — file poll interval when NATS is primary
FILE_POLL_INTERVAL_ONLY=0.5   # seconds — file poll interval when NATS is down

# ── Ensure directories exist ────────────────────────────────────────────────

mkdir -p "$STATE_DIR" "$QUEUE_DIR" "$REPLY_DIR"


# ── Early exit: watcher not active ──────────────────────────────────────────

if [[ ! -f "$ACTIVE_FILE" ]]; then
    exit 0
fi

# ── Logging ──────────────────────────────────────────────────────────────────

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] HOOK: $*" >> "$LOG_FILE"
}

# ── Tmux detection ───────────────────────────────────────────────────────────

HAS_TMUX=false
if command -v tmux &>/dev/null && [[ -n "${TMUX:-}" ]]; then
    HAS_TMUX=true
fi

# Find the tmux pane that owns this hook process by walking up the PID tree
# and matching against tmux pane PIDs.
find_pane_id() {
    if [[ "$HAS_TMUX" != "true" ]]; then echo "no-tmux"; return; fi
    local current=$PPID
    local search_pids=()
    for _ in 1 2 3 4; do
        search_pids+=("$current")
        current=$(ps -o ppid= -p "$current" 2>/dev/null | tr -d ' ')
        [[ -z "$current" || "$current" == "1" ]] && break
    done
    while IFS='|' read -r pn pp; do
        for sp in "${search_pids[@]}"; do
            [[ "$pp" == "$sp" ]] && { echo "$pn"; return; }
        done
    done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}|#{pane_pid}' 2>/dev/null)
    echo "unknown"
}

# ── Read payload from stdin ──────────────────────────────────────────────────

payload=$(cat)
[[ -z "$payload" ]] && exit 0

# ── Parse payload via Node.js ────────────────────────────────────────────────
# Extract fields into shell variables. Node writes shell-safe assignments to a
# temp file which we source.

_parse_tmp=$(mktemp)
_script_tmp=$(mktemp)
cat > "$_script_tmp" << 'NODESCRIPT'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(0, "utf8"));

// Log raw payload for debugging
try {
    fs.appendFileSync("/tmp/claude-watcher/payloads.log",
        "[" + new Date().toISOString() + "] " + p.hook_event_name + "/" + (p.tool_name || "") + "\n" +
        JSON.stringify(p, null, 2) + "\n---\n");
} catch(e) {}

// Single-quote wrap for safe shell sourcing
const sq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

console.log("session_id=" + sq(p.session_id || ""));
console.log("hook_event=" + sq(p.hook_event_name || ""));
console.log("tool_name=" + sq(p.tool_name || ""));
console.log("cwd=" + sq(p.cwd || ""));
console.log("notif_type=" + sq(p.notification_type || ""));
console.log("message=" + sq(p.message || ""));
console.log("prompt=" + sq(p.prompt || ""));
console.log("hook_launch_ts=" + String(Date.now()));
NODESCRIPT

node "$_script_tmp" <<< "$payload" > "$_parse_tmp" 2>/dev/null
rm -f "$_script_tmp"
# shellcheck disable=SC1090
source "$_parse_tmp" 2>/dev/null || { rm -f "$_parse_tmp"; log "Parse failed"; exit 0; }
rm -f "$_parse_tmp"

# ── Detect pane and project ──────────────────────────────────────────────────

pane=$(find_pane_id)
project=$(basename "${cwd:-unknown}")

log "Event: $hook_event | Tool: $tool_name | Pane: $pane"

# ── Determine if this is a blocking hook ─────────────────────────────────────

is_blocking=false
if [[ "$hook_event" == "PermissionRequest" || "$hook_event" == "Elicitation" ]]; then
    is_blocking=true
fi

# ── Build reply subject and file path (for blocking hooks) ───────────────────

reply_subject=""
reply_file_path=""
if [[ "$is_blocking" == "true" ]]; then
    reply_subject="claude.reply.${session_id}.$$"
    reply_file_path="$REPLY_DIR/${session_id}-$$.json"
fi

# ── Build envelope JSON ─────────────────────────────────────────────────────
# We use Node.js to safely construct JSON from shell variables + raw payload.

_env_script=$(mktemp)
cat > "$_env_script" << 'ENVSCRIPT'
const fs = require("fs");

// Read arguments from env vars (passed via process.env to avoid shell escaping)
const sessionId = process.env._ENV_SESSION_ID || "";
const hookEvent = process.env._ENV_HOOK_EVENT || "";
const toolName = process.env._ENV_TOOL_NAME || "";
const cwd = process.env._ENV_CWD || "";
const pane = process.env._ENV_PANE || "";
const project = process.env._ENV_PROJECT || "";
const hookLaunchTs = parseInt(process.env._ENV_HOOK_LAUNCH_TS, 10) || Date.now();
const pid = process.env._ENV_PID || "";
const replySubject = process.env._ENV_REPLY_SUBJECT || "";
const replyFilePath = process.env._ENV_REPLY_FILE_PATH || "";

// Read raw payload from stdin
const rawPayload = JSON.parse(fs.readFileSync(0, "utf8"));

// Timestamp for eventId
const tsMs = String(Date.now());

const envelope = {
    eventId: sessionId + ":" + pid + ":" + tsMs,
    type: hookEvent,
    session_id: sessionId,
    tool_name: toolName,
    cwd: cwd,
    hookLaunchTimestamp: hookLaunchTs,
    pane: pane,
    project: project,
    raw_payload: rawPayload
};

// Add reply fields for blocking hooks
if (replySubject) {
    envelope.replySubject = replySubject;
    envelope.replyFilePath = replyFilePath;
}

process.stdout.write(JSON.stringify(envelope));
ENVSCRIPT

envelope=$(
    _ENV_SESSION_ID="$session_id" \
    _ENV_HOOK_EVENT="$hook_event" \
    _ENV_TOOL_NAME="$tool_name" \
    _ENV_CWD="$cwd" \
    _ENV_PANE="$pane" \
    _ENV_PROJECT="$project" \
    _ENV_HOOK_LAUNCH_TS="$hook_launch_ts" \
    _ENV_PID="$$" \
    _ENV_REPLY_SUBJECT="$reply_subject" \
    _ENV_REPLY_FILE_PATH="$reply_file_path" \
    node "$_env_script" <<< "$payload" 2>/dev/null
)
rm -f "$_env_script"

if [[ -z "$envelope" ]]; then
    log "ERROR: Failed to build envelope"
        exit 0
fi

# ── Publish to NATS (with file-queue fallback) ──────────────────────────────

nats_ok=false

# nats-publish.js has its own 2s connection timeout — no external timeout needed
if echo "$envelope" | node "$SCRIPT_DIR/nats-publish.js" 2>/dev/null; then
    nats_ok=true
    log "Published to NATS: $hook_event/$tool_name"
else
    # NATS failed — write to file queue as durability fallback
    _ts=$(node -e "process.stdout.write(String(Date.now()))" 2>/dev/null || echo "0")
    _fallback_file="$QUEUE_DIR/${_ts}-${session_id}-$$.json"
    echo "$envelope" > "$_fallback_file"
    log "NATS unavailable, wrote to file queue: $_fallback_file"
fi


# ── Fire-and-forget hooks: exit immediately ──────────────────────────────────

if [[ "$is_blocking" == "false" ]]; then
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# Blocking hooks: PermissionRequest & Elicitation
# Wait for reply from the popup daemon, then write response to stdout.
# ══════════════════════════════════════════════════════════════════════════════

log "Blocking hook ($hook_event): waiting for reply on $reply_subject / $reply_file_path"

reply_json=""

if [[ "$nats_ok" == "true" ]]; then
    # ── Dual-wait: NATS subscription + file poll (via nats-wait-reply.js) ────
    # nats-wait-reply.js handles both NATS sub and file poll internally.
    # It prints the reply JSON to stdout on success, exits 1 on timeout.

    # nats-wait-reply.js handles its own internal timeout, so we just run it directly
    reply_json=$(
        node "$SCRIPT_DIR/nats-wait-reply.js" \
            "$reply_subject" \
            "$BLOCKING_REPLY_TIMEOUT" \
            "$reply_file_path" \
        2>/dev/null
    ) || true

    if [[ -n "$reply_json" ]]; then
        log "Blocking hook ($hook_event): reply received via NATS/dual-wait"
    fi
else
    # ── File-only wait: poll reply file every 500ms ──────────────────────────
    # NATS was down, so the daemon will write the reply file after processing
    # the event from the file queue.

    _deadline=$(( $(node -e "process.stdout.write(String(Date.now()))" 2>/dev/null) + BLOCKING_REPLY_TIMEOUT * 1000 ))
    log "Blocking hook ($hook_event): file-only poll (NATS was down)"

    while true; do
        _now=$(node -e "process.stdout.write(String(Date.now()))" 2>/dev/null)
        if (( _now >= _deadline )); then
            log "Blocking hook ($hook_event): file-only poll timed out after ${BLOCKING_REPLY_TIMEOUT}s"
            break
        fi

        if [[ -f "$reply_file_path" ]]; then
            reply_json=$(cat "$reply_file_path" 2>/dev/null || true)
            if [[ -n "$reply_json" ]]; then
                log "Blocking hook ($hook_event): reply received via file poll"
                break
            fi
        fi

        sleep "$FILE_POLL_INTERVAL_ONLY"
    done
fi

# ── Emit reply or timeout fallback ───────────────────────────────────────────

if [[ -n "$reply_json" ]]; then
    echo "$reply_json"
    log "Blocking hook ($hook_event): emitted reply to stdout"
else
    # Timeout — emit safe default
    log "Blocking hook ($hook_event): TIMEOUT — emitting safe fallback"

    if [[ "$hook_event" == "PermissionRequest" ]]; then
        cat <<'FALLBACK_JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
FALLBACK_JSON
        log "Blocking hook (PermissionRequest): fallback = allow"
    elif [[ "$hook_event" == "Elicitation" ]]; then
        cat <<'FALLBACK_JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "decline"
  }
}
FALLBACK_JSON
        log "Blocking hook (Elicitation): fallback = decline"
    fi
fi

exit 0

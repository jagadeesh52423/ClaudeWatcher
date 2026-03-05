#!/usr/bin/env bash
#
# on-claude-notify.sh - Hook handler called by Claude Code's hook system
#
# This script is invoked by Claude Code when events fire (permission prompts,
# idle state, elicitations). It receives a JSON payload on stdin, determines
# which tmux pane the session is in, and sends a macOS notification + auto-focus.
#

STATE_DIR="/tmp/claude-watcher"
ALERTS_DIR="$STATE_DIR/alerts"
LOG_FILE="$STATE_DIR/watcher.log"
AUTO_FOCUS="${CLAUDE_WATCHER_AUTO_FOCUS:-true}"
SOUND_FILE="${CLAUDE_WATCHER_SOUND:-/System/Library/Sounds/Glass.aiff}"

mkdir -p "$STATE_DIR" "$ALERTS_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] HOOK: $*" >> "$LOG_FILE"
}

# ── Read JSON payload from stdin ─────────────────────────────────────────────

payload=$(cat)

if [[ -z "$payload" ]]; then
    log "Empty payload received, exiting"
    exit 0
fi

# Parse fields using node
parsed=$(node -e "
    try {
        const p = JSON.parse(process.argv[1]);
        const out = {
            event: p.hook_event_name || '',
            notif_type: p.notification_type || '',
            message: p.message || '',
            title: p.title || 'Claude Code',
            session_id: p.session_id || '',
            cwd: p.cwd || ''
        };
        console.log(JSON.stringify(out));
    } catch(e) {
        console.log('{}');
    }
" "$payload" 2>/dev/null) || parsed="{}"

hook_event=$(echo "$parsed" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.event||'')" 2>/dev/null || true)
notif_type=$(echo "$parsed" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.notif_type||'')" 2>/dev/null || true)
message=$(echo "$parsed" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.message||'')" 2>/dev/null || true)
cwd=$(echo "$parsed" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.cwd||'')" 2>/dev/null || true)

log "Event: $hook_event | Type: $notif_type | CWD: $cwd"

# ── Determine alert type ────────────────────────────────────────────────────

alert_type=""
alert_title=""
alert_message=""

case "$hook_event" in
    Notification)
        case "$notif_type" in
            permission_prompt)
                alert_type="permission"
                alert_title="Claude needs permission"
                alert_message="Waiting for Allow/Deny"
                ;;
            idle_prompt)
                alert_type="idle"
                alert_title="Claude is idle"
                alert_message="Waiting for your input"
                ;;
        esac
        ;;
    Elicitation)
        alert_type="question"
        alert_title="Claude has a question"
        alert_message="Asking you a question"
        ;;
    PermissionRequest)
        alert_type="permission"
        alert_title="Claude needs permission"
        alert_message="Permission requested for a tool"
        ;;
esac

if [[ -z "$alert_type" ]]; then
    log "No actionable event, skipping"
    exit 0
fi

# ── Find which tmux pane this Claude session is in ───────────────────────────

find_tmux_pane() {
    # Walk up the process tree from our parent (Claude's node process)
    # Process tree: tmux-server → bash (pane_pid) → node (claude) → this script
    local claude_pid=$PPID
    local search_pids=()

    # Collect PIDs walking up the tree
    local current=$claude_pid
    for _ in 1 2 3 4; do
        search_pids+=("$current")
        current=$(ps -o ppid= -p "$current" 2>/dev/null | tr -d ' ')
        [[ -z "$current" || "$current" == "1" ]] && break
    done

    # Match against tmux pane PIDs
    while IFS='|' read -r pane pane_pid; do
        for spid in "${search_pids[@]}"; do
            if [[ "$pane_pid" == "$spid" ]]; then
                echo "$pane"
                return
            fi
        done
    done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}|#{pane_pid}' 2>/dev/null)

    echo "unknown"
}

pane=$(find_tmux_pane)
project=$(basename "${cwd:-unknown}")

log "Pane: $pane | Project: $project | Alert: $alert_type"

# ── Send notification ────────────────────────────────────────────────────────

subtitle="$project"
[[ "$pane" != "unknown" ]] && subtitle="$pane — $project"

osascript -e "display notification \"$alert_message\" with title \"$alert_title\" subtitle \"$subtitle\" sound name \"Glass\"" 2>/dev/null &

if [[ -f "$SOUND_FILE" ]]; then
    afplay "$SOUND_FILE" 2>/dev/null &
fi

# ── Write alert state ────────────────────────────────────────────────────────

if [[ "$pane" != "unknown" ]]; then
    alert_file="$ALERTS_DIR/${pane//[:.]/_}"
    echo "$alert_type" > "$alert_file"
fi

# ── Auto-focus ───────────────────────────────────────────────────────────────

if [[ "$AUTO_FOCUS" == "true" ]] && [[ "$pane" != "unknown" ]]; then
    # Detect terminal app
    term_app=$(osascript -e '
        tell application "System Events"
            set appList to name of every application process whose visible is true
        end tell
        if appList contains "iTerm2" then
            return "iTerm2"
        else
            return "Terminal"
        end if
    ' 2>/dev/null || echo "Terminal")

    # Bring terminal to front
    osascript -e "tell application \"$term_app\" to activate" 2>/dev/null &

    # Switch tmux to the right pane
    session="${pane%%:*}"
    win_pane="${pane#*:}"
    tmux switch-client -t "$session" 2>/dev/null || true
    tmux select-window -t "$session:${win_pane%%.*}" 2>/dev/null || true
    tmux select-pane -t "$pane" 2>/dev/null || true

    log "Auto-focused: $pane"
fi

exit 0

#!/usr/bin/env bash
#
# on-claude-notify.sh - Hook handler called by Claude Code's hook system
#
# Invoked by Claude Code when events fire.  Receives a JSON payload on stdin.
#
# PreToolUse — Claude waits and reads stdout for allow/deny decision.
#   Shows a blocking GUI dialog; outputs {"decision":"allow"} or {"decision":"deny"}
#   so Claude can proceed without the user touching the terminal.
#
# Elicitation — Claude waits and reads stdout for the user's response.
#   Shows a blocking text-input dialog; outputs the response as JSON.
#
# Notification — fire-and-forget.
#   Sends a macOS notification (no response needed).
#
# Works with or without tmux.
#

STATE_DIR="/tmp/claude-watcher"
ALERTS_DIR="$STATE_DIR/alerts"
QUEUE_DIR="$STATE_DIR/popup-queue"
LOG_FILE="$STATE_DIR/watcher.log"
AUTO_FOCUS="${CLAUDE_WATCHER_AUTO_FOCUS:-true}"
SOUND_FILE="${CLAUDE_WATCHER_SOUND:-/System/Library/Sounds/Glass.aiff}"
ACTIVE_FILE="$STATE_DIR/active"

mkdir -p "$STATE_DIR" "$ALERTS_DIR" "$QUEUE_DIR"

# Exit silently if the watcher is not active (i.e. `claude-watcher stop` was called)
if [[ ! -f "$ACTIVE_FILE" ]]; then
    exit 0
fi

# Detect whether tmux is available and we're inside a tmux session
HAS_TMUX=false
if command -v tmux &>/dev/null && [[ -n "${TMUX:-}" ]]; then
    HAS_TMUX=true
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] HOOK: $*" >> "$LOG_FILE"
}

as_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ── Read JSON payload from stdin ──────────────────────────────────────────────

payload=$(cat)

if [[ -z "$payload" ]]; then
    log "Empty payload received, exiting"
    exit 0
fi

# Parse all relevant fields in one node pass
parsed=$(node -e "
    try {
        const p = JSON.parse(process.argv[1]);
        const tool = p.tool_use || {};
        const toolName  = p.tool_name  || tool.name  || '';
        const toolInput = p.tool_input || tool.input || {};
        let inputSummary = '';
        try {
            const s = JSON.stringify(toolInput);
            inputSummary = s.length > 200 ? s.slice(0, 197) + '...' : s;
            if (inputSummary === '{}') inputSummary = '';
        } catch(e) {}

        const out = {
            event:        p.hook_event_name    || '',
            notif_type:   p.notification_type  || '',
            message:      p.message            || '',
            title:        p.title              || 'Claude Code',
            session_id:   p.session_id         || '',
            cwd:          p.cwd                || '',
            tool_name:    toolName,
            tool_summary: inputSummary,
            prompt:       p.prompt             || (p.request_info && p.request_info.prompt) || ''
        };
        console.log(JSON.stringify(out));
    } catch(e) {
        console.log('{}');
    }
" "$payload" 2>/dev/null) || parsed="{}"

_field() {
    echo "$parsed" | node -e \
        "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d['$1']||'')" \
        2>/dev/null || true
}

hook_event=$(_field event)
notif_type=$(_field notif_type)
message=$(_field message)
cwd=$(_field cwd)
tool_name=$(_field tool_name)
tool_summary=$(_field tool_summary)
prompt=$(_field prompt)

log "Event: $hook_event | Type: $notif_type | Tool: $tool_name | CWD: $cwd"

# ── Find which tmux pane this Claude session lives in ────────────────────────

find_pane_id() {
    if [[ "$HAS_TMUX" != "true" ]]; then
        echo "no-tmux"
        return
    fi

    local current=$PPID
    local search_pids=()
    for _ in 1 2 3 4; do
        search_pids+=("$current")
        current=$(ps -o ppid= -p "$current" 2>/dev/null | tr -d ' ')
        [[ -z "$current" || "$current" == "1" ]] && break
    done

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

pane=$(find_pane_id)
project=$(basename "${cwd:-unknown}")
log "Pane: $pane | Project: $project | tmux: $HAS_TMUX"

# ── Focus helpers ────────────────────────────────────────────────────────────

detect_terminal_app() {
    osascript -e '
        tell application "System Events"
            set appList to name of every application process whose visible is true
        end tell
        if appList contains "iTerm2" then return "iTerm2"
        if appList contains "Alacritty" then return "Alacritty"
        if appList contains "kitty" then return "kitty"
        if appList contains "WezTerm" then return "WezTerm"
        if appList contains "Hyper" then return "Hyper"
        return "Terminal"
    ' 2>/dev/null || echo "Terminal"
}

focus_pane() {
    local term_app
    term_app=$(detect_terminal_app)
    osascript -e "tell application \"$term_app\" to activate" 2>/dev/null || true

    if [[ "$HAS_TMUX" == "true" && -n "$pane" && "$pane" != "unknown" && "$pane" != "no-tmux" ]]; then
        local session="${pane%%:*}"
        local win_pane="${pane#*:}"
        tmux switch-client -t "$session" 2>/dev/null || true
        tmux select-window -t "$session:${win_pane%%.*}" 2>/dev/null || true
        tmux select-pane -t "$pane" 2>/dev/null || true
    fi
}

# ── PreToolUse: blocking dialog + JSON decision ─────────────────────────────
# Claude reads stdout from PreToolUse hooks for {"decision":"allow"/"deny"}.
# This is the correct hook type for controlling tool execution via popup.

if [[ "$hook_event" == "PreToolUse" ]]; then
    if [[ -n "$tool_name" ]]; then
        dialog_msg="Tool: $tool_name"
        [[ -n "$tool_summary" ]] && dialog_msg="$dialog_msg

$tool_summary"
    elif [[ -n "$message" ]]; then
        dialog_msg="$message"
    else
        dialog_msg="Claude wants to use a tool."
    fi

    st=$(as_escape "Claude Code — Allow Tool?")
    sm=$(as_escape "$dialog_msg")

    result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set dlg to display dialog "$sm" ¬
        with title "$st" ¬
        with icon caution ¬
        buttons {"Deny", "Allow Once", "Always Allow"} ¬
        default button "Allow Once" ¬
        giving up after 120
    if gave up of dlg then return "Allow Once"
    return button returned of dlg
on error
    return "Deny"
end try
APPL
    ) || result="Deny"

    log "PreToolUse dialog result: '$result' for tool=$tool_name"

    case "$result" in
        "Allow Once")
            echo '{"decision": "allow"}'
            exit 0
            ;;
        "Always Allow")
            echo '{"decision": "allow", "allow_permanently": true}'
            exit 0
            ;;
        "Deny"|*)
            echo '{"decision": "deny", "reason": "User denied via popup"}'
            exit 0
            ;;
    esac
fi

# ── PermissionRequest: just focus the terminal (fallback) ────────────────────
# PermissionRequest is informational — Claude doesn't read stdout from it.
# If PreToolUse didn't handle it, just focus the terminal so user sees the prompt.

if [[ "$hook_event" == "PermissionRequest" ]]; then
    log "PermissionRequest — focusing terminal (handled by PreToolUse hook)"
    [[ "$AUTO_FOCUS" == "true" ]] && focus_pane
    exit 0
fi

# ── Elicitation: blocking dialog + JSON response ────────────────────────────

if [[ "$hook_event" == "Elicitation" ]]; then
    if [[ -n "$prompt" ]]; then
        dialog_msg="$prompt"
    elif [[ -n "$message" ]]; then
        dialog_msg="$message"
    else
        dialog_msg="Claude is asking you a question."
    fi

    st=$(as_escape "Claude Code — Question")
    sm=$(as_escape "$dialog_msg")

    result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set dlg to display dialog "$sm" ¬
        with title "$st" ¬
        default answer "" ¬
        buttons {"Skip", "Send"} ¬
        default button "Send" ¬
        giving up after 300
    if gave up of dlg then return "__POPUP_SKIP__"
    if button returned of dlg is "Send" then
        return text returned of dlg
    else
        return "__POPUP_SKIP__"
    end if
on error
    return "__POPUP_SKIP__"
end try
APPL
    ) || result="__POPUP_SKIP__"

    log "Elicitation dialog result: '${result:0:80}' -> pane $pane"

    if [[ "$result" != "__POPUP_SKIP__" && -n "$result" ]]; then
        json_value=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$result" 2>/dev/null)
        echo "{\"result\": $json_value}"
        exit 0
    else
        log "Elicitation skipped, falling back to terminal"
        [[ "$AUTO_FOCUS" == "true" ]] && focus_pane
        exit 2
    fi
fi

# ── Notification events ──────────────────────────────────────────────────────

if [[ "$hook_event" == "Notification" ]]; then
    subtitle="$project"
    [[ -n "$pane" && "$pane" != "unknown" && "$pane" != "no-tmux" ]] && subtitle="$pane — $project"

    case "$notif_type" in
        permission_prompt)
            osascript -e "display notification \"${message:-Waiting for permission}\" with title \"Claude needs permission\" subtitle \"$subtitle\" sound name \"Glass\"" 2>/dev/null &
            log "Permission notification sent"
            ;;
        idle_prompt)
            log "Idle notification — skipping"
            ;;
        *)
            osascript -e "display notification \"${message:-Needs attention}\" with title \"Claude Code\" subtitle \"$subtitle\" sound name \"Glass\"" 2>/dev/null &
            log "Generic notification sent: $notif_type"
            ;;
    esac
    exit 0
fi

log "No actionable event ($hook_event), skipping"
exit 0

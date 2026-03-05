#!/usr/bin/env bash
#
# on-claude-notify.sh - Hook handler for Claude Code
#
# PermissionRequest — fires ONLY when permission is needed. Shows popup dialog,
#   returns hookSpecificOutput with decision.behavior = allow/deny.
#   Supports "Always Allow" via updatedPermissions from permission_suggestions.
#
# PreToolUse — fires for ALL tool calls. For AskUserQuestion/ExitPlanMode,
#   shows dynamic options popup and sends selection via tmux.
#   For all others, exits 0 silently (let normal permission system handle it).
#
# Notification — fire-and-forget macOS notification.
#
# Works with or without tmux.
#

STATE_DIR="/tmp/claude-watcher"
LOG_FILE="$STATE_DIR/watcher.log"
AUTO_FOCUS="${CLAUDE_WATCHER_AUTO_FOCUS:-true}"
ACTIVE_FILE="$STATE_DIR/active"

mkdir -p "$STATE_DIR"

if [[ ! -f "$ACTIVE_FILE" ]]; then
    exit 0
fi

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

# ── Read + parse payload in one node call ─────────────────────────────────────

payload=$(cat)
[[ -z "$payload" ]] && exit 0

# Single node call extracts everything we need
eval "$(node -e '
    const p = JSON.parse(process.argv[1]);
    const ti = p.tool_input || {};
    const ps = p.permission_suggestions || [];

    // tool summary
    let ts = "";
    try {
        const s = JSON.stringify(ti);
        ts = s.length > 300 ? s.slice(0, 297) + "..." : s;
        if (ts === "{}") ts = "";
    } catch(e) {}

    // AskUserQuestion options
    let qText = "", optLabels = [], optList = "";
    if ((p.tool_name || "") === "AskUserQuestion" && ti.questions && ti.questions[0]) {
        const q = ti.questions[0];
        qText = q.question || q.header || "";
        (q.options || []).forEach((o, i) => {
            const label = o.label || o.value || String(o);
            const desc = o.description ? " - " + o.description : "";
            optLabels.push(label);
            optList += (i+1) + ". " + label + desc + "\n";
        });
    }

    // permission_suggestions as JSON for updatedPermissions
    const psJson = ps.length > 0 ? JSON.stringify(ps) : "";

    const esc = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/`/g, "\\`").replace(/\\$/g, "\\$");

    console.log("hook_event=\"" + esc(p.hook_event_name || "") + "\"");
    console.log("tool_name=\"" + esc(p.tool_name || "") + "\"");
    console.log("tool_summary=\"" + esc(ts) + "\"");
    console.log("notif_type=\"" + esc(p.notification_type || "") + "\"");
    console.log("message=\"" + esc(p.message || "") + "\"");
    console.log("cwd=\"" + esc(p.cwd || "") + "\"");
    console.log("prompt=\"" + esc(p.prompt || "") + "\"");
    console.log("question_text=\"" + esc(qText) + "\"");
    console.log("option_labels=\"" + esc(optLabels.join("|")) + "\"");
    console.log("option_count=" + optLabels.length);
    console.log("perm_suggestions=\"" + esc(psJson) + "\"");
' "$payload" 2>/dev/null)" 2>/dev/null || { log "Parse failed"; exit 0; }

log "Event: $hook_event | Tool: $tool_name | Opts: $option_count"

# ── Pane / focus helpers ─────────────────────────────────────────────────────

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

pane=$(find_pane_id)
project=$(basename "${cwd:-unknown}")

detect_terminal_app() {
    osascript -e '
        tell application "System Events"
            set appList to name of every application process whose visible is true
        end tell
        if appList contains "iTerm2" then return "iTerm2"
        if appList contains "Alacritty" then return "Alacritty"
        if appList contains "kitty" then return "kitty"
        if appList contains "WezTerm" then return "WezTerm"
        return "Terminal"
    ' 2>/dev/null || echo "Terminal"
}

focus_pane() {
    local ta
    ta=$(detect_terminal_app)
    osascript -e "tell application \"$ta\" to activate" 2>/dev/null || true
    if [[ "$HAS_TMUX" == "true" && "$pane" != "unknown" && "$pane" != "no-tmux" ]]; then
        tmux switch-client -t "${pane%%:*}" 2>/dev/null || true
        tmux select-window -t "${pane%%.*}" 2>/dev/null || true
        tmux select-pane -t "$pane" 2>/dev/null || true
    fi
}

send_keys() {
    [[ "$HAS_TMUX" != "true" || "$pane" == "unknown" || "$pane" == "no-tmux" ]] && return 0
    local p="$pane"; shift
    for k in "$@"; do tmux send-keys -t "$p" "$k" 2>/dev/null || true; done
}

# ══════════════════════════════════════════════════════════════════════════════
# PermissionRequest — fires ONLY when permission is needed
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "PermissionRequest" ]]; then
    # Build dialog message
    if [[ -n "$tool_name" ]]; then
        dialog_msg="Tool: $tool_name"
        [[ -n "$tool_summary" ]] && dialog_msg="$dialog_msg\n\n$tool_summary"
    else
        dialog_msg="Claude needs your permission."
    fi

    st=$(as_escape "Claude Code — Permission")
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

    log "PermissionRequest result: '$result' for $tool_name"

    case "$result" in
        "Allow Once")
            cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
ENDJSON
            exit 0
            ;;
        "Always Allow")
            # Use permission_suggestions from payload for updatedPermissions
            if [[ -n "$perm_suggestions" ]]; then
                node -e '
                    const ps = JSON.parse(process.argv[1]);
                    console.log(JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: "PermissionRequest",
                            decision: {
                                behavior: "allow",
                                updatedPermissions: ps
                            }
                        }
                    }));
                ' "$perm_suggestions" 2>/dev/null
            else
                cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
ENDJSON
            fi
            exit 0
            ;;
        "Deny"|*)
            cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "User denied via popup"
    }
  }
}
ENDJSON
            exit 0
            ;;
    esac
fi

# ══════════════════════════════════════════════════════════════════════════════
# PreToolUse — fires for ALL tool calls
# Only intercept AskUserQuestion and ExitPlanMode for dynamic popup options.
# Everything else: exit 0 (let normal permission system handle it).
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "PreToolUse" ]]; then

    # ── AskUserQuestion: dynamic options popup ───────────────────────────────
    if [[ "$tool_name" == "AskUserQuestion" && "$option_count" -gt 0 ]]; then
        log "AskUserQuestion: '$question_text' ($option_count options)"

        # Build AppleScript list
        as_list=""
        IFS='|' read -ra labels <<< "$option_labels"
        for i in "${!labels[@]}"; do
            [[ -n "$as_list" ]] && as_list+=", "
            as_list+="\"$((i+1)). ${labels[$i]}\""
        done
        as_list+=", \"$((${#labels[@]}+1)). Type something\""

        sq=$(as_escape "$question_text")

        result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set chosen to choose from list {${as_list}} ¬
        with title "Claude Code" ¬
        with prompt "$sq" ¬
        OK button name "Select" ¬
        cancel button name "Skip"
    if chosen is false then return "SKIP"
    return item 1 of chosen
on error
    return "SKIP"
end try
APPL
        ) || result="SKIP"

        log "AskUserQuestion result: '$result'"

        # Allow the tool to proceed
        cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
ENDJSON

        # Send selection via tmux in background
        if [[ "$result" != "SKIP" ]]; then
            selected_num="${result%%.*}"
            (
                sleep 1.0
                if [[ "$selected_num" -le "$option_count" ]]; then
                    for (( i=1; i<selected_num; i++ )); do
                        send_keys Down; sleep 0.1
                    done
                    send_keys Enter
                else
                    for (( i=1; i<=option_count; i++ )); do
                        send_keys Down; sleep 0.1
                    done
                    send_keys Enter
                fi
                log "Sent AskUser selection $selected_num"
            ) &
        fi
        exit 0
    fi

    # ── ExitPlanMode: plan approval popup ────────────────────────────────────
    if [[ "$tool_name" == "ExitPlanMode" ]]; then
        log "ExitPlanMode: showing plan approval popup"

        result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set chosen to choose from list {"1. Yes, clear context and auto-accept edits", "2. Yes, auto-accept edits", "3. Yes, manually approve edits", "4. Type feedback"} ¬
        with title "Claude Code — Plan Ready" ¬
        with prompt "Claude has written a plan. How to proceed?" ¬
        OK button name "Select" ¬
        cancel button name "Skip"
    if chosen is false then return "SKIP"
    return item 1 of chosen
on error
    return "SKIP"
end try
APPL
        ) || result="SKIP"

        log "ExitPlanMode result: '$result'"

        # Allow the tool
        cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
ENDJSON

        if [[ "$result" != "SKIP" ]]; then
            selected_num="${result%%.*}"
            (
                sleep 1.0
                for (( i=1; i<selected_num; i++ )); do
                    send_keys Down; sleep 0.1
                done
                send_keys Enter
                log "Sent plan approval selection $selected_num"
            ) &
        fi
        exit 0
    fi

    # ── All other tools: exit 0 silently (normal permission system) ──────────
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# Notification — fire-and-forget
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "Notification" ]]; then
    subtitle="$project"
    [[ "$pane" != "unknown" && "$pane" != "no-tmux" ]] && subtitle="$pane — $project"

    case "$notif_type" in
        permission_prompt)
            osascript -e "display notification \"${message:-Permission needed}\" with title \"Claude Code\" subtitle \"$subtitle\" sound name \"Glass\"" 2>/dev/null &
            ;;
        idle_prompt)
            log "Idle notification — skipping"
            ;;
        *)
            osascript -e "display notification \"${message:-Needs attention}\" with title \"Claude Code\" subtitle \"$subtitle\" sound name \"Glass\"" 2>/dev/null &
            ;;
    esac
    exit 0
fi

exit 0

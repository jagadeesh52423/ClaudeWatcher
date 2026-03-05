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

# Single node call extracts everything we need.
# Payload is passed via stdin (not argv) to avoid shell metacharacter issues
# with $(), backticks, etc. in tool_input commands.
# Node writes to a temp file; we source it (no eval of stdout).
_parse_tmp=$(mktemp)
_script_tmp=$(mktemp)
cat > "$_script_tmp" << 'NODESCRIPT'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(0, "utf8"));
const ti = p.tool_input || {};
const ps = p.permission_suggestions || [];

// Log raw payload for debugging
const logDir = "/tmp/claude-watcher";
try {
    fs.appendFileSync(logDir + "/payloads.log",
        "[" + new Date().toISOString() + "] " + p.hook_event_name + "/" + (p.tool_name || "") + "\n" +
        JSON.stringify(p, null, 2) + "\n---\n");
} catch(e) {}

let ts = "";
try {
    const s = JSON.stringify(ti);
    ts = s.length > 300 ? s.slice(0, 297) + "..." : s;
    if (ts === "{}") ts = "";
} catch(e) {}

// Generic options extraction — try multiple payload locations
let qText = "", optLabels = [];

// 1. AskUserQuestion: tool_input.questions[0].options
if ((p.tool_name || "") === "AskUserQuestion" && ti.questions && ti.questions[0]) {
    const q = ti.questions[0];
    qText = q.question || q.header || "";
    (q.options || []).forEach((o) => {
        optLabels.push(o.label || o.value || String(o));
    });
}

// 2. Elicitation: top-level or nested questions/options
if (optLabels.length === 0 && (p.hook_event_name || "") === "Elicitation") {
    // Try p.questions[0].options
    if (p.questions && p.questions[0]) {
        const q = p.questions[0];
        qText = q.question || q.header || q.prompt || p.message || "";
        (q.options || []).forEach((o) => {
            optLabels.push(o.label || o.value || String(o));
        });
    }
    // Try p.options directly
    if (optLabels.length === 0 && Array.isArray(p.options)) {
        qText = p.message || p.prompt || "";
        p.options.forEach((o) => {
            optLabels.push(typeof o === "string" ? o : (o.label || o.value || String(o)));
        });
    }
    // Fallback: use message/prompt as question text even if no options
    if (!qText) qText = p.message || p.prompt || "";
}

// 3. ExitPlanMode / EnterPlanMode: tool_input may have options
if (optLabels.length === 0 && ti.options && Array.isArray(ti.options)) {
    qText = ti.question || ti.prompt || ti.message || p.message || "";
    ti.options.forEach((o) => {
        optLabels.push(typeof o === "string" ? o : (o.label || o.value || String(o)));
    });
}

const psJson = ps.length > 0 ? JSON.stringify(ps) : "";

// Single-quote wrap: replace ' with '\'' for safe shell sourcing
const sq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

console.log("hook_event=" + sq(p.hook_event_name || ""));
console.log("tool_name=" + sq(p.tool_name || ""));
console.log("tool_summary=" + sq(ts));
console.log("notif_type=" + sq(p.notification_type || ""));
console.log("message=" + sq(p.message || ""));
console.log("cwd=" + sq(p.cwd || ""));
console.log("prompt=" + sq(p.prompt || ""));
console.log("question_text=" + sq(qText));
console.log("option_labels=" + sq(optLabels.join("|")));
console.log("option_count=" + optLabels.length);
console.log("perm_suggestions=" + sq(psJson));
NODESCRIPT
node "$_script_tmp" <<< "$payload" > "$_parse_tmp" 2>/dev/null
rm -f "$_script_tmp"
# shellcheck disable=SC1090
source "$_parse_tmp" 2>/dev/null || { rm -f "$_parse_tmp"; log "Parse failed"; exit 0; }
rm -f "$_parse_tmp"

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

    # ── Tool with dynamic options (e.g. AskUserQuestion) ─────────────────
    if [[ "$option_count" -gt 0 ]]; then
        log "PermissionRequest with options: $tool_name '$question_text' ($option_count options)"

        as_list=""
        IFS='|' read -ra labels <<< "$option_labels"
        for i in "${!labels[@]}"; do
            [[ -n "$as_list" ]] && as_list+=", "
            as_list+="\"$((i+1)). $(as_escape "${labels[$i]}")\""
        done
        as_list+=", \"$((${#labels[@]}+1)). Type something\""

        sq=$(as_escape "${question_text:-Claude is asking...}")

        result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set chosen to choose from list {${as_list}} ¬
        with title "Claude Code — $tool_name" ¬
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

        log "PermissionRequest options result: '$result'"

        # Allow the tool so it proceeds
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
                log "Sent options selection $selected_num for $tool_name"
            ) &
        fi
        exit 0
    fi

    # ── Standard permission dialog (Deny / Allow Once / Always Allow) ────
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
# Exit 0 silently; PermissionRequest handles popups (both permissions and
# dynamic options) so we don't show duplicate dialogs.
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "PreToolUse" ]]; then
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# Elicitation — Claude is asking the user a question (with or without options)
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "Elicitation" ]]; then
    if [[ "$option_count" -gt 0 ]]; then
        # Has options — show choose-from-list popup
        log "Elicitation with options: '$question_text' ($option_count options)"

        as_list=""
        IFS='|' read -ra labels <<< "$option_labels"
        for i in "${!labels[@]}"; do
            [[ -n "$as_list" ]] && as_list+=", "
            as_list+="\"$((i+1)). $(as_escape "${labels[$i]}")\""
        done
        as_list+=", \"$((${#labels[@]}+1)). Type something\""

        sq=$(as_escape "${question_text:-Claude is asking...}")

        result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set chosen to choose from list {${as_list}} ¬
        with title "Claude Code — Question" ¬
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

        log "Elicitation result: '$result'"

        if [[ "$result" != "SKIP" ]]; then
            selected_num="${result%%.*}"
            (
                sleep 0.5
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
                log "Sent Elicitation selection $selected_num"
            ) &
        fi
    else
        # No options — free-text input dialog
        log "Elicitation free-text: '$question_text'"

        sq=$(as_escape "${question_text:-${message:-Claude is asking you a question.}}")

        result=$(osascript 2>/dev/null <<APPL
tell application "System Events" to activate
try
    set dlg to display dialog "$sq" ¬
        with title "Claude Code — Question" ¬
        default answer "" ¬
        buttons {"Skip", "Send"} ¬
        default button "Send" ¬
        giving up after 300
    if gave up of dlg then return "__SKIP__"
    if button returned of dlg is "Send" then
        return text returned of dlg
    else
        return "__SKIP__"
    end if
on error
    return "__SKIP__"
end try
APPL
        ) || result="__SKIP__"

        log "Elicitation text result: '${result:0:80}'"

        if [[ "$result" != "__SKIP__" && -n "$result" ]]; then
            (
                sleep 0.5
                if [[ "$HAS_TMUX" == "true" && "$pane" != "unknown" && "$pane" != "no-tmux" ]]; then
                    tmux send-keys -t "$pane" -l "$result" 2>/dev/null || true
                    tmux send-keys -t "$pane" Enter 2>/dev/null || true
                fi
                log "Sent Elicitation text response"
            ) &
        fi
    fi
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

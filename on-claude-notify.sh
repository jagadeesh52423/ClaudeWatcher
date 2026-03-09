#!/usr/bin/env bash
#
# on-claude-notify.sh - Hook handler for Claude Code
#
# PermissionRequest — fires ONLY when permission is needed. Shows popup dialog,
#   returns hookSpecificOutput with decision.behavior = allow/deny.
#   Supports "Always Allow" via updatedPermissions from permission_suggestions.
#
# PreToolUse — exits 0 silently (PermissionRequest handles popups).
#
# Elicitation — dynamic options or free-text popup.
#
# Notification — fire-and-forget macOS notification.
#
# Uses popup-gui.js (JXA/Cocoa NSAlert) for professional native dialogs.
# Works with or without tmux.
#

STATE_DIR="/tmp/claude-watcher"
LOG_FILE="$STATE_DIR/watcher.log"
ACTIVE_FILE="$STATE_DIR/active"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_SCRIPT="$SCRIPT_DIR/popup-gui.js"

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


# ── Read + parse payload in one node call ─────────────────────────────────────

payload=$(cat)
[[ -z "$payload" ]] && exit 0

# Payload is passed via stdin to node (not argv) to avoid shell metacharacter
# issues. Node writes shell assignments to a temp file; we source it.
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
let qText = "", optLabels = [], isMultiSelect = false;

// 1. AskUserQuestion: tool_input.questions[0].options
if ((p.tool_name || "") === "AskUserQuestion" && ti.questions && ti.questions[0]) {
    const q = ti.questions[0];
    qText = q.question || q.header || "";
    isMultiSelect = !!q.multiSelect;
    (q.options || []).forEach((o) => {
        optLabels.push(o.label || o.value || String(o));
    });
}

// 2. Elicitation: top-level or nested questions/options
if (optLabels.length === 0 && (p.hook_event_name || "") === "Elicitation") {
    if (p.questions && p.questions[0]) {
        const q = p.questions[0];
        qText = q.question || q.header || q.prompt || p.message || "";
        isMultiSelect = isMultiSelect || !!q.multiSelect;
        (q.options || []).forEach((o) => {
            optLabels.push(o.label || o.value || String(o));
        });
    }
    if (optLabels.length === 0 && Array.isArray(p.options)) {
        qText = p.message || p.prompt || "";
        p.options.forEach((o) => {
            optLabels.push(typeof o === "string" ? o : (o.label || o.value || String(o)));
        });
    }
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

// Single-quote wrap for safe shell sourcing
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
console.log("multi_select=" + (isMultiSelect ? "true" : "false"));
console.log("perm_suggestions=" + sq(psJson));

// Pre-build GUI params JSON files (proper JSON.stringify — no shell escaping needed)
const cwd = p.cwd || "";
const proj = cwd ? require("path").basename(cwd) : "";
const toolName = p.tool_name || "";

// Options dialog params
if (optLabels.length > 0) {
    const optGui = JSON.stringify({
        type: "options",
        title: "Claude Code" + (toolName ? " — " + toolName : ""),
        message: qText || "Choose an option:",
        options: optLabels,
        multiSelect: isMultiSelect
    });
    fs.writeFileSync(logDir + "/gui-options.json", optGui);
    console.log("gui_options_file=" + sq(logDir + "/gui-options.json"));
} else {
    console.log("gui_options_file=''");
}

// Permission dialog params
const permGui = JSON.stringify({
    type: "permission",
    tool: toolName || "Unknown",
    summary: ts,
    project: proj
});
fs.writeFileSync(logDir + "/gui-permission.json", permGui);
console.log("gui_permission_file=" + sq(logDir + "/gui-permission.json"));

// Text dialog params
const textGui = JSON.stringify({
    type: "text",
    title: "Claude Code — Question",
    message: qText || p.message || p.prompt || "Claude is asking you a question."
});
fs.writeFileSync(logDir + "/gui-text.json", textGui);
console.log("gui_text_file=" + sq(logDir + "/gui-text.json"));
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
    if [[ "$option_count" -gt 0 && -n "$gui_options_file" ]]; then
        log "PermissionRequest with options: $tool_name '$question_text' ($option_count options, multiSelect=$multi_select)"

        result=$(osascript -l JavaScript "$GUI_SCRIPT" "$gui_options_file" 2>/dev/null) || result="SKIP"

        log "PermissionRequest options result: '$result'"

        if [[ "$result" != "SKIP" && "$result" != "ERROR:"* ]]; then

            # ── Multi-select result: pipe-separated indices like "1|3|OTHER:text"
            if [[ "$multi_select" == "true" ]]; then
                log "Multi-select result: '$result'"
                _ans_tmp=$(mktemp)
                cat > "$_ans_tmp" << 'MSSCRIPT'
const qText = process.argv[2];
const rawResult = process.argv[3];
const labelsStr = process.argv[4];
const labels = labelsStr.split("|");
const parts = rawResult.split("|");
const selected = [];
let typedText = "";
parts.forEach(p => {
    if (p.startsWith("OTHER:")) {
        typedText = p.slice(6);
    } else {
        const idx = parseInt(p, 10) - 1;
        if (idx >= 0 && idx < labels.length) selected.push(labels[idx]);
    }
});
if (typedText) selected.push(typedText);
const answer = selected.join(", ");
const r = {
    hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
            behavior: "allow",
            updatedInput: { answers: {} }
        }
    }
};
r.hookSpecificOutput.decision.updatedInput.answers[qText] = answer;
console.log(JSON.stringify(r));
MSSCRIPT
                node "$_ans_tmp" "$question_text" "$result" "$option_labels" 2>/dev/null
                rm -f "$_ans_tmp"

            # ── Single-select result: "N. label" or "OTHER:typed text"
            else
                if [[ "$result" == OTHER:* ]]; then
                    selected_label="${result#OTHER:}"
                    log "Typed custom answer: '$selected_label' for '$question_text'"
                else
                    selected_num="${result%%.*}"
                    IFS='|' read -ra sel_labels <<< "$option_labels"
                    selected_label="${sel_labels[$((selected_num-1))]}"
                    log "Selected: '$selected_label' for '$question_text'"
                fi

                _ans_tmp=$(mktemp)
                cat > "$_ans_tmp" << 'ANSSCRIPT'
const qText = process.argv[2];
const answer = process.argv[3];
const r = {
    hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
            behavior: "allow",
            updatedInput: { answers: {} }
        }
    }
};
r.hookSpecificOutput.decision.updatedInput.answers[qText] = answer;
console.log(JSON.stringify(r));
ANSSCRIPT
                node "$_ans_tmp" "$question_text" "$selected_label" 2>/dev/null
                rm -f "$_ans_tmp"
            fi
        else
            cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
ENDJSON
        fi
        exit 0
    fi

    # ── Standard permission dialog (Deny / Allow Once / Always Allow) ────

    result=$(osascript -l JavaScript "$GUI_SCRIPT" "$gui_permission_file" 2>/dev/null) || result="Deny"

    log "PermissionRequest result: '$result' for $tool_name"

    case "$result" in
        "Allow Once")
            cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
ENDJSON
            exit 0
            ;;
        "Always Allow")
            if [[ -n "$perm_suggestions" ]]; then
                _ps_tmp=$(mktemp)
                cat > "$_ps_tmp" << 'PSSCRIPT'
const ps = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
    hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: ps }
    }
}));
PSSCRIPT
                node "$_ps_tmp" "$perm_suggestions" 2>/dev/null
                rm -f "$_ps_tmp"
            else
                cat <<'ENDJSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
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
    "decision": { "behavior": "deny", "message": "User denied via popup" }
  }
}
ENDJSON
            exit 0
            ;;
    esac
fi

# ══════════════════════════════════════════════════════════════════════════════
# PreToolUse — fires for ALL tool calls
# Exit 0 silently; PermissionRequest handles popups.
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "PreToolUse" ]]; then
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# Elicitation — Claude is asking the user a question
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$hook_event" == "Elicitation" ]]; then
    if [[ "$option_count" -gt 0 && -n "$gui_options_file" ]]; then
        log "Elicitation with options: '$question_text' ($option_count options, multiSelect=$multi_select)"

        result=$(osascript -l JavaScript "$GUI_SCRIPT" "$gui_options_file" 2>/dev/null) || result="SKIP"

        log "Elicitation result: '$result'"

        if [[ "$result" != "SKIP" && "$result" != "ERROR:"* ]]; then

            if [[ "$multi_select" == "true" ]]; then
                # Multi-select: result is "1|3|OTHER:text" — need to toggle each with Space
                IFS='|' read -ra ms_parts <<< "$result"
                # Build space-separated list of selected indices
                ms_indices=""
                ms_typed=""
                for part in "${ms_parts[@]}"; do
                    if [[ "$part" == OTHER:* ]]; then
                        ms_typed="${part#OTHER:}"
                    else
                        ms_indices="$ms_indices $part"
                    fi
                done
                (
                    sleep 0.5
                    # Walk through all options, toggling selected ones with Space
                    for (( i=1; i<=option_count; i++ )); do
                        should_select=false
                        for idx in $ms_indices; do
                            [[ "$idx" == "$i" ]] && should_select=true
                        done
                        if [[ "$should_select" == "true" ]]; then
                            send_keys Space; sleep 0.1
                        fi
                        if [[ "$i" -lt "$option_count" ]]; then
                            send_keys Down; sleep 0.1
                        fi
                    done

                    # If user typed something, navigate to "Other" and select it
                    if [[ -n "$ms_typed" ]]; then
                        send_keys Down; sleep 0.1
                        send_keys Space; sleep 0.1
                    fi

                    send_keys Enter
                    log "Sent Elicitation multi-select: indices=$ms_indices typed=$ms_typed"
                ) &

            else
                # Single-select: "N. label" or "OTHER:typed text"
                if [[ "$result" == OTHER:* ]]; then
                    typed_text="${result#OTHER:}"
                    (
                        sleep 0.5
                        # Navigate to "Other" (last item)
                        for (( i=1; i<=option_count; i++ )); do
                            send_keys Down; sleep 0.1
                        done
                        send_keys Enter
                        sleep 0.3
                        # Type the custom text
                        if [[ "$HAS_TMUX" == "true" && "$pane" != "unknown" && "$pane" != "no-tmux" ]]; then
                            tmux send-keys -t "$pane" -l "$typed_text" 2>/dev/null || true
                            tmux send-keys -t "$pane" Enter 2>/dev/null || true
                        fi
                        log "Sent Elicitation typed text: '$typed_text'"
                    ) &
                else
                    selected_num="${result%%.*}"
                    (
                        sleep 0.5
                        for (( i=1; i<selected_num; i++ )); do
                            send_keys Down; sleep 0.1
                        done
                        send_keys Enter
                        log "Sent Elicitation selection $selected_num"
                    ) &
                fi
            fi
        fi
    else
        log "Elicitation free-text: '$question_text'"

        result=$(osascript -l JavaScript "$GUI_SCRIPT" "$gui_text_file" 2>/dev/null) || result="__SKIP__"

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

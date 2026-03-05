# Claude Watcher

Monitor all your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions across tmux and get notified the moment any session needs your attention — permission prompts, questions, plan approvals, or idle state. Automatically brings the right terminal pane to the foreground.

## The Problem

When running multiple Claude Code sessions in different tmux windows/panes, you can easily miss when one of them:
- Asks for **permission** to run a tool (Allow/Deny prompt)
- Has a **question** for you (AskUserQuestion / Elicitation)
- Finished a **plan** and awaits your approval
- Got **interrupted** and needs direction
- Went **idle** waiting for your next prompt

## How It Works

Two detection layers work together for reliable coverage:

| Layer | Method | Latency | Coverage |
|-------|--------|---------|----------|
| **Hooks** | Claude Code's built-in hook system fires events (`permission_prompt`, `idle_prompt`, `Elicitation`, `PermissionRequest`) | Instant | New sessions (after hook install + restart) |
| **Scanner** | Polls all tmux panes every 3s, captures content via `tmux capture-pane`, and pattern-matches the TUI for attention indicators | ~3s | All sessions, including ones started before hooks were installed |

When attention is needed:
1. **macOS notification** appears (with sound)
2. **Alert sound** plays (`Glass.aiff` by default)
3. **Auto-focus** brings your terminal app to the macOS foreground and switches tmux to the exact session/window/pane

## Quick Start

```bash
# Clone
git clone https://github.com/jagadeesh52423/ClaudeWatcher.git
cd ClaudeWatcher

# Make executable
chmod +x claude-watcher on-claude-notify.sh

# Install hooks into Claude Code settings
./claude-watcher install

# Start the background watcher daemon
./claude-watcher start -d

# Check all your sessions
./claude-watcher status
```

### Optional: Add to PATH

```bash
# Symlink for global access
ln -s "$(pwd)/claude-watcher" ~/bin/claude-watcher
# or
ln -s "$(pwd)/claude-watcher" /usr/local/bin/claude-watcher
```

## Commands

| Command | Description |
|---------|-------------|
| `claude-watcher start [-d]` | Start watching. `-d` runs as a background daemon. |
| `claude-watcher stop` | Stop the background daemon. |
| `claude-watcher status` | Show all Claude sessions with their current state. |
| `claude-watcher focus [pane]` | Bring terminal to front and switch to the first session needing attention (or a specific pane). |
| `claude-watcher install` | Install notification hooks into `~/.claude/settings.json`. |
| `claude-watcher uninstall` | Remove hooks from Claude settings. |

## Status Dashboard

`claude-watcher status` gives you a live overview:

```
  Claude Watcher - Session Status
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◎  eventengine:1.1              HAS INPUT
  ◯  eventengine:2.1              IDLE
  📋 marketplace:1.1              PLAN APPROVAL
  ●  multi-agent-system:2.1       WORKING
  ⏸  multi-agent-system:3.1       INTERRUPTED

  ● Watcher: running (PID: 79300)
  2 session(s) need your attention!
```

### State Icons

| Icon | State | Meaning |
|------|-------|---------|
| `⚠` | NEEDS PERMISSION | Claude is showing an Allow/Deny prompt |
| `?` | ASKING QUESTION | Claude is asking you a question with options |
| `📋` | PLAN APPROVAL | A plan is ready for your review |
| `⏸` | INTERRUPTED | Session was interrupted, needs direction |
| `◯` | IDLE | Finished, waiting for your next prompt |
| `◎` | HAS INPUT | Idle but user has typed something in the prompt |
| `●` | WORKING | Actively processing |

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_WATCHER_INTERVAL` | `3` | Scan interval in seconds |
| `CLAUDE_WATCHER_SOUND` | `/System/Library/Sounds/Glass.aiff` | Alert sound file path |
| `CLAUDE_WATCHER_AUTO_FOCUS` | `true` | Automatically bring terminal to front and switch to the alerting pane |
| `CLAUDE_WATCHER_COOLDOWN` | `30` | Seconds between repeat alerts for the same pane in the same state |

Example:
```bash
# Quieter mode: no auto-focus, longer cooldown, different sound
CLAUDE_WATCHER_AUTO_FOCUS=false \
CLAUDE_WATCHER_COOLDOWN=60 \
CLAUDE_WATCHER_SOUND=/System/Library/Sounds/Submarine.aiff \
claude-watcher start -d
```

## How Detection Works

### Hook-Based (Real-Time)

The `install` command adds hooks to `~/.claude/settings.json`:

- **Notification** hook — fires on `permission_prompt` and `idle_prompt` events
- **Elicitation** hook — fires when Claude asks you a question
- **PermissionRequest** hook — fires when a tool needs approval

When triggered, Claude Code invokes `on-claude-notify.sh` with a JSON payload on stdin containing the event type, session ID, and working directory. The script maps the Claude process back to its tmux pane via process tree traversal (`PPID` → parent shell → `tmux list-panes` pane_pid match).

> **Note:** Hooks require restarting Claude Code sessions after installation.

### Scanner-Based (Polling)

The background daemon runs `tmux capture-pane -p` on every pane running Claude and pattern-matches the last 25 lines for:

- `Allow once` / `Always allow` / `Deny` → permission prompt
- Selection UI with `❯` marker and `Other` option → question/elicitation
- `awaiting approval` / `Approve` / `Start implementation` → plan approval
- `Interrupted` in the last 10 lines → interrupted state
- `? for shortcuts` / `⏵⏵ accept edits` with empty prompt → idle

Claude panes are identified by checking if any child of the tmux pane's shell process matches `claude` (via `pgrep -P`).

### Terminal App Support

Auto-detects and activates the correct terminal app:
- Terminal.app
- iTerm2
- Alacritty
- kitty

## Requirements

- **macOS** (uses `osascript` for notifications and terminal activation)
- **tmux** (sessions must be running in tmux)
- **Claude Code CLI** (the sessions being monitored)
- **Node.js** (used by the install/uninstall commands to safely modify JSON settings)

## Files

```
ClaudeWatcher/
├── claude-watcher          # Main CLI script — all commands
├── on-claude-notify.sh     # Hook handler called by Claude Code
└── .gitignore
```

Runtime state is stored in `/tmp/claude-watcher/` (alerts, PID file, log).

## Uninstall

```bash
# Remove hooks from Claude settings
claude-watcher uninstall

# Stop the daemon
claude-watcher stop

# Remove the symlink
rm ~/bin/claude-watcher

# Remove the repo
rm -rf /path/to/ClaudeWatcher
```

## License

MIT

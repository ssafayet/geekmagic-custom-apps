#!/bin/sh
# Claude Code usage bridge for a server running in Docker — no Node or pnpm needed.
#
# A native install uses `pnpm bridge:*` instead. This script does the same two jobs
# with only sh, curl and a JSON tool (jq, which macOS 15+ ships; plutil or python3
# also work for reading):
#
#   statusline  Claude Code's status-line hook. Forwards each render to the server.
#               Fires only where a status line is drawn: terminal `claude`, not the
#               VS Code extension.
#   push        Reads usage from the local Claude Code cache and posts it. Covers the
#               VS Code extension, which never draws a status line. Run it on a timer.
#
# Usage: tools/claude-bridge.sh <command>
#   install           Hook the status line into Claude Code's settings.json
#   uninstall         Restore the status line that was there before
#   install-agent     Run `push` every 5 minutes (launchd on macOS, systemd on Linux)
#   uninstall-agent   Remove that timer
#   push              Read usage now and post it
#   doctor            Explain anything that is not arriving
#
# The token comes from GCA_BRIDGE_TOKEN in the environment, or else from the .env
# beside compose.yaml — the same line the container reads, so there is nothing to
# keep in sync. GCA_PORT there is honoured too.

set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "$0")"
REPO_DIR=$(dirname -- "$SCRIPT_DIR")
ENV_FILE=${GCA_ENV_FILE:-"$REPO_DIR/.env"}
STATE_DIR=${GCA_BRIDGE_STATE_DIR:-"${XDG_CONFIG_HOME:-$HOME/.config}/geekmagic-custom-apps"}
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
PREVIOUS_JSON="$STATE_DIR/previous-statusline.json"
PREVIOUS_CMD="$STATE_DIR/previous-statusline.cmd"
AGENT_LABEL=dev.gca.claude-push
PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PUSH_INTERVAL_SECONDS=300
# Matches the server: `/usage` takes several seconds and a network round trip, and
# the windows it reports move on a five-hour cycle, so refreshing more often buys nothing.
USAGE_MAX_AGE_MS=300000

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

# Reads NAME from the .env file the way Compose does for simple lines: the last
# assignment wins, surrounding quotes are dropped, and an unquoted value ends at " #".
env_file_value() {
  [ -r "$ENV_FILE" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n 1 | tr -d '\r')
  [ -n "$line" ] || return 0
  value=${line#*=}
  case $value in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
    *) value=$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//') ;;
  esac
  printf '%s' "$value"
}

read_token() {
  if [ -n "${GCA_BRIDGE_TOKEN:-}" ]; then printf '%s' "$GCA_BRIDGE_TOKEN"; return; fi
  env_file_value GCA_BRIDGE_TOKEN
}

token_source() {
  if [ -n "${GCA_BRIDGE_TOKEN:-}" ]; then say "the GCA_BRIDGE_TOKEN environment variable"
  else say "$ENV_FILE"; fi
}

endpoint() {
  if [ -n "${GCA_BRIDGE_ENDPOINT:-}" ]; then printf '%s' "$GCA_BRIDGE_ENDPOINT"; return; fi
  port=${GCA_PORT:-$(env_file_value GCA_PORT)}
  printf 'http://127.0.0.1:%s/internal/claude/statusline' "${port:-3210}"
}

# The first JSON reader available, unless GCA_JSON_TOOL picks one.
json_tool() {
  if [ -n "${GCA_JSON_TOOL:-}" ]; then printf '%s' "$GCA_JSON_TOOL"; return; fi
  for tool in jq plutil python3; do
    if command -v "$tool" >/dev/null 2>&1; then printf '%s' "$tool"; return; fi
  done
}

# Prints the scalar at a dotted path in a JSON file, or nothing.
json_get() {
  case $(json_tool) in
    jq) jq -r --arg p "$2" 'getpath($p | split(".")) // empty' "$1" 2>/dev/null ;;
    plutil) plutil -extract "$2" raw -o - "$1" 2>/dev/null ;;
    python3)
      python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value.get(key) if isinstance(value, dict) else None
print("" if value is None else value)
PY
      ;;
    *) return 1 ;;
  esac
}

claude_config_file() {
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ -r "$CLAUDE_CONFIG_DIR/.claude.json" ]; then
    printf '%s' "$CLAUDE_CONFIG_DIR/.claude.json"
  else
    printf '%s' "$HOME/.claude.json"
  fi
}

# Where a user-installed Claude Code commonly lives, for timers that run with a bare PATH.
find_claude() {
  if command -v claude >/dev/null 2>&1; then command -v claude; return; fi
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/bin/claude" \
    /usr/local/bin/claude /opt/homebrew/bin/claude; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return; fi
  done
}

now_ms() { printf '%s000' "$(date +%s)"; }

is_number() {
  case $1 in '' | *[!0-9.]* | *.*.*) return 1 ;; *) return 0 ;; esac
}

# Runs `claude -p /usage`, which refreshes the cache and is not a model call. Bounded,
# because a timer must not pile up behind a CLI that hangs. Polled rather than raced
# against a background `sleep`, which would outlive this script holding its stdout.
refresh_usage() {
  "$1" -p /usage --output-format json >/dev/null 2>&1 &
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 60 ]; then kill "$pid" 2>/dev/null; break; fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  return 0
}

# Claude Code's own status-line shape, so the server keeps one parser: only the two
# windows the display shows, and only when both halves of a window are present.
usage_payload() {
  file=$1
  body=''
  for window in five_hour seven_day; do
    used=$(json_get "$file" "cachedUsageUtilization.utilization.$window.utilization")
    resets=$(json_get "$file" "cachedUsageUtilization.utilization.$window.resets_at")
    is_number "$used" || continue
    case $resets in '' | *\"* | *\\*) continue ;; esac
    [ -n "$body" ] && body="$body,"
    body="$body\"$window\":{\"used_percentage\":$used,\"resets_at\":\"$resets\"}"
  done
  [ -n "$body" ] || return 1
  printf '{"rate_limits":{%s}}' "$body"
}

cmd_statusline() {
  # Must never disrupt Claude Code: every failure is swallowed and nothing is printed
  # except the previous status line, if there was one.
  input=$(cat)
  token=$(read_token 2>/dev/null)
  if [ -n "$token" ]; then
    printf '%s' "$input" | curl -s -m 2 -o /dev/null \
      -H "Authorization: Bearer $token" -H 'content-type: application/json' \
      --data-binary @- "$(endpoint)" >/dev/null 2>&1
  fi
  if [ -r "$PREVIOUS_CMD" ]; then
    printf '%s\n' "$input" | sh -c "$(cat "$PREVIOUS_CMD")"
    return $?
  fi
  return 0
}

cmd_push() {
  token=$(read_token)
  [ -n "$token" ] || fail "No bridge token. Set GCA_BRIDGE_TOKEN in $ENV_FILE (the same value the container uses)."
  [ -n "$(json_tool)" ] || fail 'Needs jq, plutil or python3 to read the Claude Code cache.'

  file=$(claude_config_file)
  fetched=$(json_get "$file" cachedUsageUtilization.fetchedAtMs)
  fetched=${fetched%%.*}
  is_number "$fetched" || fetched=0
  if [ $(( $(now_ms) - fetched )) -gt "$USAGE_MAX_AGE_MS" ]; then
    claude=$(find_claude)
    [ -n "$claude" ] || fail 'No claude binary found. Install Claude Code and sign in.'
    refresh_usage "$claude"
  fi

  payload=$(usage_payload "$file") ||
    fail 'Claude Code reported no usage windows yet. Run claude once, then retry.'

  response=$(printf '%s' "$payload" | curl -s -m 10 -w '\n%{http_code}' \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    --data-binary @- "$(endpoint)") || fail "Cannot reach $(endpoint). Is the container running?"
  status=$(printf '%s' "$response" | tail -n 1)
  case $status in
    200)
      windows=''
      case $payload in *five_hour*) windows='5h' ;; esac
      case $payload in *seven_day*) windows="${windows:+$windows, }7d" ;; esac
      say "Pushed usage ($windows)."
      ;;
    202) fail "The server could not use the payload: $(printf '%s' "$response" | sed '$d')" ;;
    401) fail 'Rejected (401). Run: tools/claude-bridge.sh doctor' ;;
    *) fail "Unexpected HTTP $status from $(endpoint)." ;;
  esac
}

is_bridge_command() {
  case $1 in *"claude-bridge.sh"*statusline*) return 0 ;; *) return 1 ;; esac
}

statusline_command() {
  printf "/bin/sh '%s' statusline" "$SCRIPT_PATH"
}

cmd_install() {
  case $SCRIPT_PATH in *\'*) fail "The checkout path contains a single quote; move it first." ;; esac
  command -v jq >/dev/null 2>&1 || {
    say 'Editing settings.json needs jq. Add this to it by hand instead:'
    say "  \"statusLine\": { \"type\": \"command\", \"command\": \"$(statusline_command)\", \"padding\": 0 }"
    exit 1
  }
  [ -n "$(read_token)" ] || fail "Set GCA_BRIDGE_TOKEN in $ENV_FILE first, then run docker compose up -d."

  mkdir -p "$CLAUDE_DIR" "$STATE_DIR"
  [ -f "$SETTINGS_FILE" ] || printf '{}\n' >"$SETTINGS_FILE"
  jq -e 'type == "object"' "$SETTINGS_FILE" >/dev/null 2>&1 ||
    fail "$SETTINGS_FILE is not a JSON object; fix it before installing."

  current=$(jq -c '.statusLine // null' "$SETTINGS_FILE")
  current_cmd=$(jq -r '.statusLine.command // empty' "$SETTINGS_FILE")
  case $current_cmd in
    *claude-statusline-bridge*)
      fail 'The Node bridge is installed. Remove it first with: pnpm bridge:uninstall' ;;
  esac

  # Re-installing keeps what the first install displaced rather than chaining the
  # bridge to itself, so running this twice is harmless.
  if ! is_bridge_command "$current_cmd"; then
    (umask 077 && printf '%s\n' "$current" >"$PREVIOUS_JSON")
    if [ -n "$current_cmd" ]; then
      (umask 077 && printf '%s\n' "$current_cmd" >"$PREVIOUS_CMD")
    else
      rm -f "$PREVIOUS_CMD"
    fi
  fi

  backup="$SETTINGS_FILE.gca-backup-$(date +%Y%m%dT%H%M%S)"
  (umask 077 && cp "$SETTINGS_FILE" "$backup")
  tmp="$SETTINGS_FILE.gca-tmp.$$"
  padding=$(jq -r '.statusLine.padding // 0' "$SETTINGS_FILE")
  (umask 077 && jq --arg cmd "$(statusline_command)" --argjson padding "$padding" \
    '.statusLine = {type: "command", command: $cmd, padding: $padding}' \
    "$SETTINGS_FILE" >"$tmp") && mv "$tmp" "$SETTINGS_FILE" ||
    { rm -f "$tmp"; fail "Could not write $SETTINGS_FILE; it is unchanged."; }

  say "Installed in $SETTINGS_FILE (backup: $backup)."
  [ -r "$PREVIOUS_CMD" ] && say 'Your previous status line still shows; the bridge runs alongside it.'
  say 'Terminal sessions now forward usage on every render. For the VS Code extension,'
  say 'also run: tools/claude-bridge.sh install-agent'
}

cmd_uninstall() {
  command -v jq >/dev/null 2>&1 || fail "Needs jq. Remove the statusLine entry from $SETTINGS_FILE by hand."
  [ -f "$SETTINGS_FILE" ] || { say 'Nothing to remove.'; return 0; }
  current_cmd=$(jq -r '.statusLine.command // empty' "$SETTINGS_FILE")
  if ! is_bridge_command "$current_cmd"; then
    say "The status line in $SETTINGS_FILE is not this bridge; leaving it alone."
    rm -f "$PREVIOUS_JSON" "$PREVIOUS_CMD"
    return 0
  fi

  previous=null
  [ -r "$PREVIOUS_JSON" ] && previous=$(cat "$PREVIOUS_JSON")
  tmp="$SETTINGS_FILE.gca-tmp.$$"
  (umask 077 && jq --argjson previous "$previous" \
    'if $previous == null then del(.statusLine) else .statusLine = $previous end' \
    "$SETTINGS_FILE" >"$tmp") && mv "$tmp" "$SETTINGS_FILE" ||
    { rm -f "$tmp"; fail "Could not write $SETTINGS_FILE; it is unchanged."; }
  rm -f "$PREVIOUS_JSON" "$PREVIOUS_CMD"
  say "Removed from $SETTINGS_FILE; the previous status line is back."
}

cmd_install_agent() {
  [ -n "$(read_token)" ] || fail "Set GCA_BRIDGE_TOKEN in $ENV_FILE first, then run docker compose up -d."
  case $(uname -s) in
    Darwin)
      logs="$HOME/Library/Logs/geekmagic-custom-apps"
      mkdir -p "$logs" "$(dirname "$PLIST")"
      cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$SCRIPT_PATH</string>
    <string>push</string>
  </array>
  <key>StartInterval</key><integer>$PUSH_INTERVAL_SECONDS</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$logs/claude-push.log</string>
  <key>StandardErrorPath</key><string>$logs/claude-push.log</string>
</dict></plist>
EOF
      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
      launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "launchctl could not load $PLIST."
      say "Pushing usage every $((PUSH_INTERVAL_SECONDS / 60)) minutes (launchd: $AGENT_LABEL)."
      say "Log: $logs/claude-push.log"
      ;;
    Linux)
      command -v systemctl >/dev/null 2>&1 || fail 'No systemd here. Run `tools/claude-bridge.sh push` from cron every 5 minutes instead.'
      mkdir -p "$SYSTEMD_DIR"
      cat >"$SYSTEMD_DIR/gca-claude-push.service" <<EOF
[Unit]
Description=Push Claude Code usage to geekmagic-custom-apps

[Service]
Type=oneshot
ExecStart=/bin/sh "$SCRIPT_PATH" push
EOF
      cat >"$SYSTEMD_DIR/gca-claude-push.timer" <<EOF
[Unit]
Description=Push Claude Code usage to geekmagic-custom-apps every 5 minutes

[Timer]
OnStartupSec=1min
OnUnitActiveSec=${PUSH_INTERVAL_SECONDS}s

[Install]
WantedBy=timers.target
EOF
      systemctl --user daemon-reload &&
        systemctl --user enable --now gca-claude-push.timer ||
        fail 'systemctl could not start the timer.'
      say "Pushing usage every $((PUSH_INTERVAL_SECONDS / 60)) minutes (systemd: gca-claude-push.timer)."
      say 'Log: journalctl --user -u gca-claude-push'
      ;;
    *) fail 'Unsupported OS. Run `tools/claude-bridge.sh push` on a timer yourself.' ;;
  esac
}

cmd_uninstall_agent() {
  case $(uname -s) in
    Darwin)
      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
      rm -f "$PLIST"
      ;;
    Linux)
      systemctl --user disable --now gca-claude-push.timer >/dev/null 2>&1
      rm -f "$SYSTEMD_DIR/gca-claude-push.service" "$SYSTEMD_DIR/gca-claude-push.timer"
      systemctl --user daemon-reload >/dev/null 2>&1
      ;;
  esac
  say 'Timer removed.'
}

cmd_doctor() {
  failed=0
  token=$(read_token)
  if [ -n "$token" ]; then
    say "Token: read from $(token_source) (${#token} chars)."
  else
    say "FAILED: no token. Set GCA_BRIDGE_TOKEN in $ENV_FILE, then run docker compose up -d."
    failed=1
  fi

  tool=$(json_tool)
  if [ -n "$tool" ]; then say "JSON reader: $tool."
  else say 'FAILED: needs jq, plutil or python3 to read usage.'; failed=1; fi

  claude=$(find_claude)
  if [ -n "$claude" ]; then say "Claude Code: $claude."
  else say 'FAILED: no claude binary found.'; failed=1; fi

  if [ -n "$tool" ]; then
    fetched=$(json_get "$(claude_config_file)" cachedUsageUtilization.fetchedAtMs)
    fetched=${fetched%%.*}
    if is_number "$fetched"; then
      say "Usage cache: $(( ($(now_ms) - fetched) / 60000 )) minutes old."
    else
      say 'Usage cache: empty. `push` fills it by running claude -p /usage.'
    fi
  fi

  if [ -f "$SETTINGS_FILE" ] && grep -q 'claude-bridge.sh' "$SETTINGS_FILE"; then
    say 'Status line: installed (terminal sessions forward usage on every render).'
  else
    say 'Status line: not installed. Run: tools/claude-bridge.sh install'
  fi

  case $(uname -s) in
    Darwin)
      if launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
        say 'Timer: loaded (covers the VS Code extension).'
      else
        say 'Timer: not loaded. The VS Code extension needs it: tools/claude-bridge.sh install-agent'
      fi
      ;;
    Linux)
      if systemctl --user is-active --quiet gca-claude-push.timer 2>/dev/null; then
        say 'Timer: active (covers the VS Code extension).'
      else
        say 'Timer: not active. The VS Code extension needs it: tools/claude-bridge.sh install-agent'
      fi
      ;;
  esac

  if [ -n "$token" ]; then
    status_url=$(endpoint | sed 's#/statusline$#/status#')
    if ! response=$(curl -s -m 4 -w '\n%{http_code}' -H "Authorization: Bearer $token" "$status_url"); then
      say "FAILED: cannot reach $status_url. Is the container running (docker compose ps)?"
      failed=1
    else
      status=$(printf '%s' "$response" | tail -n 1)
      body=$(printf '%s' "$response" | sed '$d')
      case $status in
        200)
          received=$(printf '%s' "$body" | sed -n 's/.*"lastReceivedAt":"\([^"]*\)".*/\1/p')
          say 'OK: the server is reachable and accepts this token.'
          if [ -n "$received" ]; then say "  Last payload received at $received."
          else say '  No payload has arrived yet. Run: tools/claude-bridge.sh push'; fi
          ;;
        401)
          failed=1
          case $body in
            *'Invalid bridge token'*)
              say 'FAILED: the server has a different token.'
              say '  The container reads .env only when it is created. Recreate it:'
              say '    docker compose up -d'
              ;;
            *)
              say 'FAILED: the server refuses this source address.'
              say '  Set GCA_BRIDGE_ALLOW_PRIVATE_SOURCES=true on the server (compose.yaml does).'
              ;;
          esac
          ;;
        *) say "FAILED: unexpected HTTP $status from $status_url."; failed=1 ;;
      esac
    fi
  fi
  return $failed
}

case ${1:-} in
  statusline) cmd_statusline ;;
  push) cmd_push ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  install-agent) cmd_install_agent ;;
  uninstall-agent) cmd_uninstall_agent ;;
  doctor) cmd_doctor ;;
  *) sed -n '2,25p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; [ -n "${1:-}" ] && exit 2 ;;
esac

#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_ID="com.vlad.polymarket-chart-bot"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$AGENT_ID.plist"
LOG_DIR="$ROOT_DIR/data/logs"

mkdir -p "$TARGET_DIR"
mkdir -p "$LOG_DIR"

cat > "$TARGET_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$AGENT_ID</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>cd "$ROOT_DIR" && npm start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOST</key>
      <string>127.0.0.1</string>
      <key>PORT</key>
      <string>3000</string>
    </dict>
  </dict>
</plist>
PLIST

launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl load "$TARGET_PLIST"
launchctl kickstart -k "gui/$(id -u)/$AGENT_ID"

echo "Installed launch agent: $AGENT_ID"
echo "Browser URL: http://127.0.0.1:3000"
echo "Logs: $LOG_DIR"

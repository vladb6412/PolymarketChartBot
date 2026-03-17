#!/bin/bash

set -euo pipefail

AGENT_ID="com.vlad.polymarket-chart-bot"
TARGET_PLIST="$HOME/Library/LaunchAgents/$AGENT_ID.plist"

if [ -f "$TARGET_PLIST" ]; then
  launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
  rm -f "$TARGET_PLIST"
fi

echo "Removed launch agent: $AGENT_ID"

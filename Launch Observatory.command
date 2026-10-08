#!/bin/bash
# Finder launches this file independently of the current working directory.
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/fnm/aliases/default/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$node_bin/node" ]; then
      export PATH="$node_bin:$PATH"
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js was not found. Install Node.js 18 or newer, then double-click to launch.'
  echo 'Download: https://nodejs.org/'
  read -r -p 'Press Enter to close...' _reply
  exit 1
fi
node scripts/launch.js
launch_status=$?
if [ "$launch_status" -ne 0 ]; then
  read -r -p 'Press Enter to close...' _reply
fi
exit "$launch_status"

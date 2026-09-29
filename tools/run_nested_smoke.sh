#!/bin/bash
# Smoke test: start an isolated nested (headless) GNOME Shell 50 on a private
# bus + isolated runtime dir, and check whether it loads the extension.
set -u
EXT_UUID="authenticator-companion@giaffa86"
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ADDR="$DBUS_SESSION_BUS_ADDRESS"

RUNTIME=$(mktemp -d /tmp/otp-rt-XXXXXX); chmod 700 "$RUNTIME"
DATA=$(mktemp -d /tmp/otp-data-XXXXXX)
CFG=$(mktemp -d /tmp/otp-cfg-XXXXXX)
mkdir -p "$DATA/gnome-shell/extensions/$EXT_UUID"
cp "$SRC/metadata.json" "$SRC/extension.js" "$SRC/stylesheet.css" "$DATA/gnome-shell/extensions/$EXT_UUID/"

export XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$CFG"
export GSETTINGS_BACKEND=keyfile
gsettings set org.gnome.shell enabled-extensions "['$EXT_UUID']" 2>/dev/null || true

export HOST_DBUS_ADDRESS="$HOST_ADDR"
exec dbus-run-session -- bash -c '
  set -u
  gjs -m '"$SRC"'/tools/provider_proxy.js >"$XDG_RUNTIME_DIR/proxy.log" 2>&1 &
  sleep 2
  echo "proxy: $(cat "$XDG_RUNTIME_DIR/proxy.log")"
  gnome-shell --headless --debug-control >"$XDG_RUNTIME_DIR/shell.log" 2>&1 &
  SHELLPID=$!
  echo "shell pid=$SHELLPID"
  for i in $(seq 1 25); do
    sleep 1
    if gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.ListExtensions >/dev/null 2>&1; then
      echo "shell up after $i s"
      break
    fi
  done
  echo "=== ListExtensions ==="
  gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.ListExtensions 2>&1 | head -c 1500
  echo
  echo "=== ExtensionErrors for ours ==="
  gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.GetExtensionErrors '"$EXT_UUID"' 2>&1 | head -c 800
  echo
  echo "=== shell.log tail ==="
  tail -30 "$XDG_RUNTIME_DIR/shell.log"
  kill $SHELLPID 2>/dev/null
  pkill -f provider_proxy.js 2>/dev/null
'
rm -rf "$RUNTIME" "$DATA" "$CFG"

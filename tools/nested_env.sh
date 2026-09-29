#!/bin/bash
# Starts an isolated nested (headless) GNOME Shell 50 on a private D-Bus session,
# with a transparent proxy to the host's running Authenticator, then runs the
# given command inside that session.
# Usage: nested_env.sh <script-to-run-inside>
set -u
SRC=/home/giaffa86/workspace_personal/otp-panel-gnome
EXT_UUID=otp-panel@giaffa86
HOST_ADDR="$DBUS_SESSION_BUS_ADDRESS"
INNER="$1"

RUNTIME=$(mktemp -d /tmp/otp-rt-XXXXXX); chmod 700 "$RUNTIME"
DATA=$(mktemp -d /tmp/otp-data-XXXXXX)
CFG=$(mktemp -d /tmp/otp-cfg-XXXXXX)
mkdir -p "$DATA/gnome-shell/extensions/$EXT_UUID" "$DATA/gnome-shell/extensions/otp-panel-test-unsafe@giaffa86"
cp "$SRC/metadata.json" "$SRC/extension.js" "$SRC/stylesheet.css" \
   "$DATA/gnome-shell/extensions/$EXT_UUID/"
cp "$SRC/tools/unsafe_helper/metadata.json" "$SRC/tools/unsafe_helper/extension.js" \
   "$DATA/gnome-shell/extensions/otp-panel-test-unsafe@giaffa86/"

export XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$CFG"
export GSETTINGS_BACKEND=keyfile
gsettings set org.gnome.shell enabled-extensions "['$EXT_UUID', 'otp-panel-test-unsafe@giaffa86']" >/dev/null 2>&1 || true

export HOST_DBUS_ADDRESS="$HOST_ADDR" INNER
export OTP_SRC="$SRC" OTP_RUNTIME="$RUNTIME"
export OTP_SKIP_PROXY="${OTP_SKIP_PROXY:-0}"
# When simulating "app not installed", hide the Flatpak D-Bus service files so
# the private bus cannot activate the provider either.
if [ "$OTP_SKIP_PROXY" = "1" ]; then
  export XDG_DATA_DIRS="/usr/share"
fi
timeout "${OTP_TIMEOUT:-100}" dbus-run-session -- bash -c '
  set -u
  if [ "$OTP_SKIP_PROXY" != "1" ]; then
    gjs -m "$OTP_SRC/tools/provider_proxy.js" >"$OTP_RUNTIME/proxy.log" 2>&1 &
    PROXY=$!
    sleep 2
  else
    PROXY=0
  fi
  gnome-shell --headless --debug-control >"$OTP_RUNTIME/shell.log" 2>&1 &
  SHELL=$!
  for i in $(seq 1 25); do
    sleep 1
    if gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.ListExtensions >/dev/null 2>&1; then break; fi
  done
  # wait for the test-only helper to enable unsafe mode, then for our extension
  for i in $(seq 1 30); do
    r=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.context.unsafe_mode" 2>/dev/null)
    case "$r" in "(true"*) break;; esac
    sleep 1
  done
  for i in $(seq 1 30); do
    r=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "!!(Main.extensionManager.lookup('otp-panel@giaffa86')?.stateObj)" 2>/dev/null)
    case "$r" in *true*) break;; esac
    sleep 1
  done
  bash "$INNER"; RC=$?
  kill -9 $SHELL 2>/dev/null
  [ "$PROXY" != "0" ] && kill -9 $PROXY 2>/dev/null
  pkill -9 -f "gnome-shell --headless" 2>/dev/null
  pkill -9 -f provider_proxy.js 2>/dev/null
  exit $RC
' 2>&1
rm -rf "$RUNTIME" "$DATA" "$CFG" 2>/dev/null || true

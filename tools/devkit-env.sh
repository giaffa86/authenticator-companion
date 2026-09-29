#!/usr/bin/env bash
# Interactive nested devkit shell (window) with GNOME Authenticator's Search
# Provider bridged from the host session bus.
#
# Why this exists: `dbus-run-session -- gnome-shell --devkit` runs on a private
# D-Bus session bus that has no org.freedesktop.secrets service. Authenticator
# therefore cannot unlock its keyring on that bus and GetInitialResultSet never
# returns, leaving the Authenticator Companion popup stuck on "Loading…". tools/provider_proxy.js
# forwards the provider calls to the already-running host Authenticator instead.
#
# Usage: ./tools/devkit-env.sh
set -euo pipefail

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_UUID="authenticator-companion@giaffa86"
HOST_ADDR="${DBUS_SESSION_BUS_ADDRESS:-}"

if [[ -z "$HOST_ADDR" ]]; then
  echo "devkit-env: DBUS_SESSION_BUS_ADDRESS is empty; run it from your graphical session." >&2
  exit 1
fi

# Install the extension files where the fresh devkit shell will look for them.
"${SRC}/scripts/sync-extension.sh"

# Ensure the extension is enabled for the next fresh shell without clobbering
# the rest of the enabled-extensions list.
current="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$current" != *"'$EXT_UUID'"* ]]; then
  inner="${current#[}"; inner="${inner%]}"
  if [[ -z "${inner// /}" ]]; then
    gsettings set org.gnome.shell enabled-extensions "['$EXT_UUID']"
  else
    gsettings set org.gnome.shell enabled-extensions "[${inner}, '$EXT_UUID']"
  fi
fi

# Run the proxy and the devkit shell on the *same* private session bus so the
# extension (inside the devkit shell) reaches the host's unlocked Authenticator.
export HOST_DBUS_ADDRESS="$HOST_ADDR"
export SRC
exec dbus-run-session -- bash -c '
  set -euo pipefail
  gjs -m "$SRC/tools/provider_proxy.js" &
  PROXY=$!
  sleep 2
  echo "[devkit-env] provider proxy pid=$PROXY" >&2
  gnome-shell --devkit
  RC=$?
  kill "$PROXY" 2>/dev/null || true
  exit "$RC"
'

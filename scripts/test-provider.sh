#!/usr/bin/env bash
# Runs the host-bus D-Bus check against the real GNOME Authenticator Search
# Provider, using the exact async Gio.DBusProxy pattern the extension uses.
# Usage: ./scripts/test-provider.sh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

exec gjs -m "${SOURCE_DIR}/tools/dbustest.js"

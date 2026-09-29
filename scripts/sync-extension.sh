#!/usr/bin/env bash
set -euo pipefail

UUID="otp-panel@giaffa86"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "${TARGET_DIR}"

# Only the runtime files are shipped; tools/, docs/, scripts/ and *.md are
# dev-only and are intentionally not copied.
cp -f "${SOURCE_DIR}/metadata.json" "${TARGET_DIR}/metadata.json"
cp -f "${SOURCE_DIR}/extension.js" "${TARGET_DIR}/extension.js"
cp -f "${SOURCE_DIR}/stylesheet.css" "${TARGET_DIR}/stylesheet.css"

# No GSettings schema by design (see AGENTS.md). Drop any stale copy from an
# older install so it cannot accidentally become authoritative.
rm -rf "${TARGET_DIR}/schemas"

gnome-extensions disable -q "${UUID}" || true

if ! gnome-extensions enable -q "${UUID}"; then
  dbus-send --session --type=method_call --dest=org.gnome.Shell \
    /org/gnome/Shell org.gnome.Shell.Extensions.ReloadExtension \
    string:"${UUID}"
fi

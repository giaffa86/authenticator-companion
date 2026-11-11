#!/usr/bin/env bash
set -euo pipefail

UUID="authenticator-companion@giaffa86"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

cd "$SOURCE_DIR"
./scripts/i18n.sh compile
while IFS= read -r file; do
    mkdir -p -- "$TARGET_DIR/$(dirname -- "$file")"
    cp -- "$file" "$TARGET_DIR/$file"
done < scripts/runtime-files.txt

glib-compile-schemas "${TARGET_DIR}/schemas/"

gnome-extensions disable -q "${UUID}" || true

if ! gnome-extensions enable -q "${UUID}"; then
  dbus-send --session --type=method_call --dest=org.gnome.Shell \
    /org/gnome/Shell org.gnome.Shell.Extensions.ReloadExtension \
    string:"${UUID}"
fi

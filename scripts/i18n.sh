#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$SOURCE"
DOMAIN=$(python3 -c 'import json; print(json.load(open("metadata.json"))["gettext-domain"])')
LANGUAGES=(it es de fr)
mapfile -t SOURCES < <(sed -n '/\.js$/p' scripts/runtime-files.txt)

extract() {
    xgettext --language=JavaScript --keyword=_ --keyword=ngettext:1,2 \
        --from-code=UTF-8 --sort-by-file --package-name="$DOMAIN" \
        --output="$1" "${SOURCES[@]}"
}

case "${1:-compile}" in
    update)
        extract "po/$DOMAIN.pot"
        for language in "${LANGUAGES[@]}"; do
            msgmerge --update --backup=none --no-fuzzy-matching "po/$language.po" "po/$DOMAIN.pot"
        done
        ;;
    compile)
        for language in "${LANGUAGES[@]}"; do
            mkdir -p "locale/$language/LC_MESSAGES"
            msgfmt --check --check-format "po/$language.po" -o "locale/$language/LC_MESSAGES/$DOMAIN.mo"
        done
        ;;
    check)
        TEMPLATE=$(mktemp /tmp/extension-i18n-XXXXXX.pot)
        trap 'rm -f -- "$TEMPLATE"' EXIT
        extract "$TEMPLATE"
        for language in "${LANGUAGES[@]}"; do
            msgfmt --check --check-format --statistics "po/$language.po" -o /dev/null
            msgcmp "po/$language.po" "$TEMPLATE"
        done
        python3 scripts/check-i18n.py "$TEMPLATE"
        ;;
    *)
        printf 'Usage: %s [update|compile|check]\n' "$0" >&2
        exit 2
        ;;
esac

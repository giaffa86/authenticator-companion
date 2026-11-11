#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$SOURCE"
./scripts/i18n.sh compile
./scripts/i18n.sh check
glib-compile-schemas --strict --dry-run schemas
UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
mkdir -p dist
ARCHIVE="$SOURCE/dist/$UUID.shell-extension.zip"
rm -f -- "$ARCHIVE"
zip -q "$ARCHIVE" -@ < scripts/runtime-files.txt
python3 - "$ARCHIVE" <<'PY'
from pathlib import Path
import sys
import zipfile
files = Path('scripts/runtime-files.txt').read_text().splitlines()
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert sorted(archive.namelist()) == sorted(files)
    for name in files:
        assert archive.read(name) == Path(name).read_bytes(), name
print('ZIP: explicit runtime manifest and source equality verified')
PY
printf 'ZIP: %s\n' "$ARCHIVE"

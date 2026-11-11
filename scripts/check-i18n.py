# SPDX-License-Identifier: GPL-3.0-or-later
import ast
import gettext
import json
from pathlib import Path
import re
import sys


def entries(path):
    result = {}
    for block in Path(path).read_text().split('\n\n'):
        key, value, target = [], [], None
        for line in block.splitlines():
            if line.startswith('msgid '):
                target = key
                target.append(ast.literal_eval(line[6:]))
            elif line.startswith('msgstr '):
                target = value
                target.append(ast.literal_eval(line[7:]))
            elif line.startswith('"') and target is not None:
                target.append(ast.literal_eval(line))
            elif not line.startswith('#'):
                target = None
        if key and ''.join(key):
            result[''.join(key)] = ''.join(value)
    return result


domain = json.loads(Path('metadata.json').read_text())['gettext-domain']
expected = entries(sys.argv[1])
assert entries(f'po/{domain}.pot').keys() == expected.keys(), 'stale POT template'
placeholders = re.compile(r'%(?:[1-9][0-9]*\$)?[sd]')
for language in ('it', 'es', 'de', 'fr'):
    source = entries(f'po/{language}.po')
    assert source.keys() == expected.keys(), f'{language}: missing or obsolete messages'
    assert not re.search(r'^#,.*\bfuzzy\b', Path(f'po/{language}.po').read_text(), re.M), language
    catalogue = gettext.translation(domain, 'locale', languages=[language])
    for key, value in source.items():
        assert value, (language, key, 'untranslated')
        assert sorted(placeholders.findall(key)) == sorted(placeholders.findall(value)), (language, key, 'format')
        assert catalogue.gettext(key) == value, (language, key, 'stale compiled catalogue')
print(f'{domain}: {len(expected)} messages complete in it, es, de, fr; compiled catalogues match')

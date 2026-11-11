# Localization verification — 2026-11-11

The interface supports English (source and fallback), Italian (`it`), Spanish
(`es`), German (`de`) and French (`fr`). GNOME chooses the language from the
session; no separate preference is needed. This repository has 56 source
messages and four complete translation catalogues, without fuzzy entries.

## Reproducible catalogue and package checks

```sh
./scripts/i18n.sh compile
./scripts/i18n.sh check
./scripts/package.sh
```

The checks extract the runtime JavaScript strings, compare source/template/PO
coverage, reject missing translations and changed format placeholders, and load
each compiled catalogue to compare it with its PO source. Packaging validates
the schema and checks ZIP members and bytes against the explicit runtime manifest.
Only compiled MO files are distributed, alongside the other runtime files.
English uses the original source strings; it needs no redundant `en.po`.

## Isolated GNOME Shell 50 matrix

All four giaffa86 extensions were staged from their runtime manifests into
private XDG profiles and private D-Bus sessions. OpenLogi and container engine
commands used synthetic backends; Authenticator's real provider was not used.
No extension was installed or reloaded in the host session.

All six cases passed: `en`, `it`, `es`, `de`, `fr`, and unsupported `nl` falling
back to English. Each case checked all 213 messages across the four projects
through GNOME's real Extension gettext domains and through the preferences
process. The actual menu/search texts, container confirmation and accessible
names with dynamic values, and Notifications Copier confirmation were checked.
All four real preferences classes loaded translated rows in every case (24
preference windows across the matrix).

Temporary evidence directories (not shipped and not durable across reboots):

- `it`: `/tmp/giaffa86-locales-it-pxxs7oqt`
- `en`: `/tmp/giaffa86-locales-en-spb_x_xg`
- `es`: `/tmp/giaffa86-locales-es-w3p_5yqa`
- `de`: `/tmp/giaffa86-locales-de-s4a_h5ok`
- `fr`: `/tmp/giaffa86-locales-fr-pm13rm5l`
- `nl (English fallback)`: `/tmp/giaffa86-locales-nl-fh4m90x6`

The existing isolated UI regression test also passed all 47 checks with
`OTP_PROVIDER=fake_provider.js`, using `tools/nested_env.sh` and
`tools/inner_uix_test.sh`. Log:
`/tmp/authenticator-i18n-regression-coc793_a/ui.log`.

Shexli reported zero errors and zero warnings on the local ZIP, with the existing
`EGO-A-005 manual_review` finding for declared clipboard access.

## Limits

This verifies catalogue coverage and runtime language loading, not a native
speaker review of every translation or every screen at every scaling factor.
User data, detection keywords, identifiers and external CLI output stay intact.
Existing security, hardware, provider, host-session and release limitations
remain open; this change does not authorize publication or close them.

## Author-requested local installation — 2026-11-11

After the isolated checks, the runtime manifest was copied to the author's
local GNOME extension directory and its schema was compiled. Every installed
runtime file was compared byte for byte with the repository. The previous
runtime files were backed up outside the repository under `/tmp`.

The active Wayland session was not restarted. A fresh login is still required
for GNOME to load the updated JavaScript and metadata; an installation does not
establish fresh-session behavior or close the existing manual verification items.

# GNOME Extension Review Guidelines

Local checklist for keeping this extension maintainable and acceptable for GNOME Shell review (it is not currently published to extensions.gnome.org, but the same bar applies).

## AI Usage

- AI assistance is acceptable, but the final code must be understood, reviewed, and maintainable by the developer.
- Do not submit pasted LLM output that contains unused abstractions, invented APIs, generic defensive code, or prompt-like comments.
- Every non-trivial code path should be explainable in GNOME Shell/GJS terms.

## Code Style

- Keep code small, direct, and consistent with existing GNOME Shell extension patterns.
- Avoid broad `try/catch` blocks unless a specific GNOME/GIO operation can reasonably fail and the recovery behavior is clear.
- Do not leave stale classes, unused settings, backup files, generated bundles, or old implementation copies in the source tree.
- Do not add comments that describe obvious code or mention AI generation.

## GNOME Shell Safety

- Do not use `Gio.DBus.session.add_filter()` in `extension.js`; it crashes GNOME Shell 50 devkit sessions (see `docs/VERIFICATION.md` §1.4).
- The extension uses one targeted async `Gio.DBusProxy` call to Authenticator's Search Provider; no global D-Bus filter and no notification interception.
- Do not import GTK or Adw in Shell runtime code; this extension has no `prefs.js` and uses only St/Clutter/Pango.
- Every `GLib.timeout_add` and signal connection created in `enable()` must be removed in `disable()`.
- Codes must never be written to GSettings, files, logs, or notifications.

## Security Model

- Authenticator is the single source of truth: accounts and codes are read only through its `org.gnome.Shell.SearchProvider2` service.
- `GetInitialResultSet` is the authoritative lock/availability gate; re-check it while the popup is open.
- Never call `GetResultMetas` with cached ids that the current availability check did not return.
- `metadata.json` must not declare a `settings-schema`; there is no persistence by design.

## Runtime Behavior

- The 1 s refresh timer runs only while the popup is open; it is removed on close.
- Codes are kept in memory only for revealed rows and dropped on copy and on popup close.
- Clipboard writes via `St.Clipboard.get_default().set_text()` are declared in `metadata.json` description.

## Packaging

- The extension UUID in `metadata.json` must match the installed directory name (`otp-panel@giaffa86`).
- Only `metadata.json`, `extension.js` and `stylesheet.css` are shipped; keep `tools/`, `docs/`, `scripts/`, `*.md` and generated bundles out of release/source packages via `.gitignore` and the sync script.
- There is no GSettings schema, so nothing to compile.
- Verify with a nested GNOME Shell after significant `extension.js` changes (see `docs/VERIFICATION.md`).

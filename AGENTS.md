# AGENTS.md

## Project type

GNOME Shell Extension (JavaScript, no build system). Name: **Authenticator Companion** (renamed from *OTP Panel*), UUID: `authenticator-companion@giaffa86`. Targets GNOME Shell 50.

There is no build step, package manager, test runner, linting, or CI. The `.js` files are loaded directly by GNOME Shell at runtime.

## Install and reload for development

```bash
./scripts/sync-extension.sh
```

This copies `metadata.json`, `extension.js` and `stylesheet.css` to `~/.local/share/gnome-shell/extensions/authenticator-companion@giaffa86/`. There is no GSettings schema to compile.

GNOME Shell 50 only enumerates extensions at startup, so the **first** install requires a logout/login (or shell restart) before the extension appears. After that, the sync script disables/enables (or reloads) it.

For substantial `extension.js` changes, GJS can cache old modules in the running session. If the extension doesn't pick up changes after reload, verify in an isolated shell:

```bash
dbus-run-session -- gnome-shell --devkit
```

Requires `mutter-devkit` installed (`sudo dnf install mutter-devkit` on Fedora). The project's runtime verification uses a nested headless shell instead; see `docs/VERIFICATION.md`.

For debugging logs: `journalctl -f -o cat /usr/bin/gnome-shell`.

## No settings schema / no persistence

The extension deliberately ships **no GSettings schema** and no `prefs.js`. Accounts and codes come only from GNOME Authenticator's Search Provider D-Bus API and are never written to GSettings, files, logs, notifications or a database (see README "Security and privacy model").

Consequences to keep in mind:

- `metadata.json` must **not** gain a `settings-schema`.
- Do not add `schemas/` or `prefs.js` without re-evaluating the security model.
- There is nothing to configure or reset at runtime by design.

## Data flow

1. `enable()` creates `AuthenticatorSearchProvider` (one async `Gio.DBusProxy` to the provider) and adds a `PanelMenu.Button` to the status area.
2. The popup has a search entry (client-side filter), a status item, a scrollable account list, and an "Open Authenticator" action.
3. While the popup is open, a 1 s timeout re-runs the availability gate (`GetInitialResultSet([''])`) and refreshes revealed codes.
4. `GetResultMetas([id, …])` returns each account's name, provider name and the current code as `clipboardText`.
5. Codes are kept in memory only for rows the user revealed; they are dropped on copy and when the popup closes.

## D-Bus contract (read-only)

- Bus name: `com.belmoussaoui.Authenticator.SearchProvider`
- Object path: `/com/belmoussaoui/Authenticator/SearchProvider`
- Interface: `org.gnome.Shell.SearchProvider2`
- Methods used: `GetInitialResultSet` (availability/lock gate) and `GetResultMetas` (name/provider/code).
- The provider is D-Bus activatable, so a call can start the app when it is not running.

The lock state matters: `GetInitialResultSet` returns `[]` while the app is locked, but `GetResultMetas` does **not** check the lock state. Always treat `GetInitialResultSet` as the authoritative gate and only call `GetResultMetas` with ids it returned. See `docs/VERIFICATION.md` §1.3.

In addition to the Search Provider, the popup's gear button opens Authenticator's settings. It first activates the app over D-Bus (`org.freedesktop.Application.Activate` on the `com.belmoussaoui.Authenticator` bus name, object path `/com/belmoussaoui/Authenticator`) so the main window exists, then activates the `preferences` GApplication action (`org.freedesktop.Application.ActivateAction`), falling back to launching the app. The intermediate `Activate` is required: the `preferences` action handler calls `app.active_window()`, which panics (SIGABRT) when the app was started as a D-Bus service by the search provider and has no window yet. This does not read or write any account data.

## GNOME Shell safety

- Do not use `Gio.DBus.session.add_filter()` in `extension.js`; it crashes GNOME Shell 50 devkit sessions (see `docs/VERIFICATION.md` §1.4).
- No notification interception, no monkey-patching of `Main.messageTray` or `Main.notificationDaemon`.
- Do not import GTK or Adw in `extension.js`; the UI uses St/Clutter/Pango only (there is no `prefs.js`).
- Signal handlers and GLib timeouts added in `enable()` must be removed in `disable()`.
- Never write codes to GSettings, files, logs or notifications.

## Packaging

The extension ships exactly three files: `metadata.json`, `extension.js`, `stylesheet.css`. No schema, no `prefs.js`, no `tools/`, no `docs/`, no `scripts/`, no `*.md`.

Create the zip for a local packed bundle:

```bash
mkdir -p /tmp/authenticator-companion-pack
zip -r -FS /tmp/authenticator-companion-pack/authenticator-companion@giaffa86.shell-extension.zip \
  metadata.json \
  extension.js \
  stylesheet.css
```

The extension is not published to extensions.gnome.org; the zip is for local `gnome-extensions install`.

Validate with Shexli before shipping (see `notifications-copier` AGENTS.md for the tool):

```bash
python3 -m venv /tmp/shexli-venv
/tmp/shexli-venv/bin/pip install -U shexli 'tree-sitter==0.25.1'
/tmp/shexli-venv/bin/shexli /tmp/authenticator-companion-pack/authenticator-companion@giaffa86.shell-extension.zip
```

Pin `tree-sitter==0.25.1`: the default `tree-sitter 0.26.0` segfaults with `tree-sitter-javascript 0.25.0` when parsing `extension.js`.

Expected current Shexli result:
- `0 errors`
- `0 warnings`
- one `manual_review` finding for `St.Clipboard.get_default()` is acceptable: clipboard access is the extension's primary purpose and is declared in `metadata.json` description.

## Key files

| File | Role |
|------|------|
| `metadata.json` | Extension manifest (UUID, shell version `["50"]`, no settings-schema) |
| `extension.js` | Entrypoint — `AuthenticatorCompanionExtension` class with `enable()`/`disable()` |
| `stylesheet.css` | Panel popup styling |
| `scripts/sync-extension.sh` | Dev install and reload script |
| `scripts/test-provider.sh` | Host-bus provider check via `tools/dbustest.js` |
| `docs/VERIFICATION.md` | Reverse-engineering + runtime verification evidence |
| `docs/OPEN_ITEMS.md` | Tracked open items (OTP-001 … OTP-005) |

## Testing

Host-bus check (talks to the real Authenticator on the real session bus):

```bash
./scripts/test-provider.sh
```

Full extension verification in an isolated nested GNOME Shell 50:

```bash
./tools/nested_env.sh /path/to/inner-test.sh
```

Simulate "app not installed":

```bash
OTP_SKIP_PROXY=1 ./tools/nested_env.sh /path/to/inner-test.sh
```

`tools/` also contains `provider_proxy.js`, the AT-SPI helpers and the test-only `unsafe_helper` extension; none of these are part of the shipped extension.

# Technical analysis and runtime verification

This document records (1) the reverse-engineering of GNOME Authenticator's
Search Provider and (2) exactly what was tested at runtime, what works and what
remains unverified.

- Host: Fedora, GNOME Shell **50.3** (Wayland), gjs 1.88.1
- App: Authenticator **4.6.2** from Flathub (runtime `org.gnome.Platform/x86_64/50`)
- Test account: a throwaway TOTP account added through Authenticator's own
  `otpauth://` import path
  (`OTP Panel Test` / `test@example.com`, public test secret `JBSWY3DPEHPK3PXP`).
  The quoted strings below are verbatim output from runs made while the extension
  was still called *OTP Panel*; the label `OTP Panel Test` is the test account's
  own name, not the extension's.

## 1. Authenticator Search Provider — analysis

### 1.1 Static metadata (installed Flatpak)

`/var/lib/flatpak/exports/share/gnome-shell/search-providers/com.belmoussaoui.Authenticator.search-provider.ini`:

```ini
[Shell Search Provider]
DesktopId=com.belmoussaoui.Authenticator.desktop
BusName=com.belmoussaoui.Authenticator.SearchProvider
ObjectPath=/com/belmoussaoui/Authenticator/SearchProvider
Version=2
DefaultDisabled=true
```

`/var/lib/flatpak/exports/share/dbus-1/services/com.belmoussaoui.Authenticator.SearchProvider.service`:

```ini
[D-BUS Service]
Name=com.belmoussaoui.Authenticator.SearchProvider
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 \
     --command=/app/bin/authenticator com.belmoussaoui.Authenticator --gapplication-service
```

So the provider is **D-Bus activatable**: the first method call starts the app in
`--gapplication-service` mode. `DefaultDisabled=true` means it is off in GNOME
search by default, which does **not** prevent a direct D-Bus call.

### 1.2 Interface

`gdbus introspect` on the object path (which also triggered activation) reports
`org.gnome.Shell.SearchProvider2` (`Version=2`):

| Method | Signature | Notes |
|---|---|---|
| `GetInitialResultSet` | `as → as` | account identifiers |
| `GetSubsearchResultSet` | `as, as → as` | not used by the extension |
| `GetResultMetas` | `as → aa{sv}` | `id`, `name`, `description`, `clipboardText` |
| `ActivateResult` | `s, as, u` | copies clipboard in the Shell |
| `LaunchSearch` | `as, u` | opens the app window |

### 1.3 Behaviour (from upstream source)

Read from the current upstream `src/application.rs` (`start_search_provider`)
and `src/models/search_provider.rs`:

- `InitialResultSet` — **returns `[]` when `self.is_locked()`**. Otherwise it
  returns identifiers `"<providerId>:<accountId>"` for the accounts whose name or
  provider name matches the terms. An empty term matches every account because
  the matcher uses `name.contains("")`.
- `ResultMetas` — builds `ResultMeta` with `name = account.name`,
  `description = provider.name`, `clipboard_text = account.code().replace(' ', "")`.
  **It does not check the lock state.**
- `ActivateResult` — posts a *code-free* notification ("One-Time password
  copied"); GNOME Shell copies `clipboardText` when the result is activated.
- `is_locked` is `true` when the app has a passphrase set (`has_set_password`,
  read from the keyring at startup) or after the lock action / auto-lock timeout.

**Security consequence:** because `GetResultMetas` ignores the lock state, an
extension must treat `GetInitialResultSet` as the authoritative availability
gate and re-check it while its popup is open, otherwise it would keep showing
codes for a locked app. Authenticator Companion does exactly that.

### 1.4 The devkit crash constraint

Per
[`notifications-copier/DEVKIT_CRASH_ANALYSIS.md`](https://github.com/giaffa86/notifications-copier/blob/main/DEVKIT_CRASH_ANALYSIS.md),
`Gio.DBus.session.add_filter()` deterministically crashes `gnome-shell --devkit`
in GNOME Shell 50. Authenticator Companion therefore uses **no global D-Bus filter** and does
no notification interception; it makes a single targeted async call to the
provider. The nested-shell test below confirms this approach does not crash the
shell.

## 2. Runtime verification

### 2.1 Method

The extension can only be loaded by a shell that enumerated it at startup, so a
*new* extension cannot be hot-loaded into the already-running login session.
Two complementary environments were used:

1. **Direct host-bus check** — a standalone GJS script using the *same*
   promisified `Gio.DBusProxy` pattern as the extension, talking to the real
   Flatpak on the real session bus.
2. **Isolated nested GNOME Shell 50.3** — `gnome-shell --headless` on a private
   D-Bus session, with a transparent proxy (`tools/provider_proxy.js`) that
   forwards the provider calls to the running host app (the private session
   cannot unlock the Flatpak keyring, so the proxy re-exposes the host's already
   unlocked instance). The extension is loaded from a temporary
   `XDG_DATA_HOME`, and `org.gnome.Shell.Eval` (enabled via a test-only helper
   extension that sets `global.context.unsafe_mode`) drives it.

   This is a real GNOME Shell 50 with the real extension code, the real
   `Gio.DBusProxy` async path and the real Authenticator data; only the bus hop
   between the nested shell and the host is bridged.

The account list and codes were cross-checked against an independent TOTP
computation (Python `hmac`/`base64`) and against direct `gdbus` calls to the
provider.

### 2.2 What was tested and works

| Check | Result |
|---|---|
| Async proxy + `GetInitialResultSet` / `GetResultMetas` from GJS (host bus) | ✅ returns `["1119:1"]` and the live code |
| Code equals independent TOTP computation | ✅ e.g. provider `262945` = local `262945` |
| Code rotates at the TOTP period boundary | ✅ `262945 → 799240`, matches countdown |
| Extension loads in GNOME Shell 50.3 | ✅ state `1` (ACTIVE), no errors |
| Panel list shows configured accounts | ✅ `test@example.com` / `OTP Panel Test` |
| Codes hidden by default | ✅ label `••••••`, `revealed=false` |
| Reveal shows the current code + countdown | ✅ `814033 · 2s`, equals a direct provider call in the same window |
| Click copies the current code | ✅ clipboard contained `791575`, exactly the provider code |
| Row returns to masked after copy | ✅ `_code=null`, `revealed=false`, label `••••••` |
| Auto-refresh on expiry while popup is open | ✅ `238645 → 868483` without user action, matches provider |
| Search filters by account name | ✅ `test` → visible, `zzz` → hidden |
| Search filters by service name | ✅ `Panel` → visible |
| App closed → first call activates it | ✅ Authenticator was not running; listing the accounts started it and returned data |
| App unavailable / call error | ✅ shows "Authenticator is not available…" + **Open Authenticator** |
| App **not installed** (provider name and desktop file absent) | ✅ extension still loads and shows the panel icon; popup reports "Authenticator is not installed.", no open-app entry, only one log line, and it retries about every 5 s instead of every second |
| Provider gate returns empty (locked) **with the popup already open** | ✅ automatic 1 s tick cleared the rows and showed "No codes available. Authenticator is locked or has no accounts." |
| Real passphrase-protected instance: popup open while locked | ✅ `rowCount:0`, "No codes available. Authenticator is locked or has no accounts." (`menuOpen:true`) |
| Real instance: lock while a code is revealed (popup already open) | ✅ `revealed:true, code:"115254"` → next 1 s tick `rowCount:0` + locked status |
| Real instance: fresh popup while still locked | ✅ close/reopen → `rowCount:0`, locked status |
| Real instance: unlock restores list + live code | ✅ `rowCount:1`, `revealed:true`, `code:"115254"` after typing the passphrase |
| Recovery after an empty/error state | ✅ list repopulates once the provider answers again |
| Clean `disable()` | ✅ `_refreshId=0`, rows destroyed, `_button=null`, `_entry=null`, no error; re-enable returns to ACTIVE |
| Closing the popup clears codes | ✅ rows destroyed, old row `_code=null`, `revealed=false` |
| No global D-Bus filter / no notification interception | ✅ (source scan); no crash in the nested session |

Exact evidence for the main flow (nested shell, `GetResultMetas` direct call at
the same moment):

```
{"rows":1,"names":["test@example.com"],"providers":["OTP Panel Test"],
 "revealed":[false],"masked":["••••••"],"statusVisible":false,"menuOpen":true}
{"revealed":true,"code":"814033","label":"814033  ·  2s","remaining":2}
direct provider: clipboardText 814033
clipboard after click: 791575  (equals provider code 791575)
```

### 2.3 What remains unverified

> Tracked in `docs/OPEN_ITEMS.md` (OTP-001 … OTP-005), with priorities and
> closure steps.

- ~~A real passphrase-protected (locked) Authenticator.~~ **Closed** (OTP-001):
  verified on a real passphrase-protected instance on 2026-09-29 — see §2.2 and
  `docs/OPEN_ITEMS.md`. The lock was triggered with the app's own `app.lock`
  action over D-Bus and undone by typing the passphrase, exercising the 1 s
  availability gate in both directions with the popup open.
- **`LaunchSearch` / `ActivateResult` from the extension.** Authenticator Companion copies the
  code itself instead of relying on Shell's result activation, so these methods
  are not used. The "Open Authenticator" entry uses `Gio.DesktopAppInfo`; its
  launch was not exercised end-to-end in the headless session.
- **Non-Flatpak packaging.** Only the Flatpak build was tested.
- **Very large account lists / many providers.** Tested with one account.
- **The final installed instance in the current login session.** Because GNOME
  Shell 50 only scans extensions at startup, the extension installed in
  `~/.local/share/gnome-shell/extensions/authenticator-companion@giaffa86` is discovered only
  after the next login; the runtime tests above used a *fresh* nested shell that
  loaded the same code.

### 2.4 Environment side effects

For the tests, one throwaway account ("OTP Panel Test" / `test@example.com`; the
label predates the rename to Authenticator Companion) was
added to Authenticator through its own `otpauth://` import, and the GNOME Shell
"toolkit accessibility" setting and a third-party extension were temporarily
touched; the settings and the third-party extension were restored afterwards.
The test account was left in place because removing it would require writing
directly to Authenticator's database/keyring; delete it from the Authenticator
UI when no longer needed.

For the OTP-001 closure a passphrase was set on the test instance with
auto-lock enabled (kept in place as the user's choice), and the document portal
(`org.freedesktop.portal.Documents`) was restarted during the session after its
systemd user unit was found in a failed state.

## 3. How to reproduce

```sh
# 1. host-bus async call (uses the same pattern as the extension)
gjs -m tools/dbustest.js

# 2. full extension verification in an isolated nested GNOME Shell 50
./tools/nested_env.sh /path/to/inner-test.sh

# 2b. observe lock/unlock behaviour on a real passphrase-protected instance:
#     tools/inner_locked_test.sh opens the popup, reveals a code and prints a
#     state snapshot every second (see its header for the coordination protocol).
./tools/nested_env.sh tools/inner_locked_test.sh

# 3. same, but with the provider hidden to simulate "app not installed":
OTP_SKIP_PROXY=1 ./tools/nested_env.sh /path/to/inner-test.sh
```

`tools/` also contains `provider_proxy.js` and the test-only `unsafe_helper`
extension; they are not shipped with Authenticator Companion.

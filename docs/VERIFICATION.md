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
| Code rotates while the popup is open | ✅ `262945 → 799240` on the next 1 s refresh |
| Extension loads in GNOME Shell 50.3 | ✅ state `1` (ACTIVE), no errors |
| Panel list shows configured accounts | ✅ `test@example.com` / `OTP Panel Test` |
| Codes hidden by default | ✅ no code line (`_codeLabel` hidden and empty), `revealed=false` |
| Reveal shows the current code | ✅ `814033`, equals a direct provider call in the same window |
| Click copies the current code | ✅ clipboard contained `791575`, exactly the provider code |
| Row returns to hidden after the copy confirmation | ✅ `_code=null`, `revealed=false`, code line hidden again after `COPY_FEEDBACK_MS` |
| Auto-refresh on expiry while popup is open | ✅ `238645 → 868483` without user action, matches provider |
| Search filters by account name | ✅ `test` → visible, `zzz` → hidden |
| Search filters by service name | ✅ `Panel` → visible |
| App closed → first call activates it | ✅ Authenticator was not running; listing the accounts started it and returned data |
| App unavailable / call error | ✅ shows "Authenticator is not available…" + **Open Authenticator** |
| App **not installed** (provider name and desktop file absent) | ✅ extension still loads and shows the panel icon; popup reports "Authenticator is not installed.", no open-app entry, only one log line, and it retries about every 5 s instead of every second |
| Open-app shortcut on the search row | ✅ activates the app and closes the popup (race test J); same `Shell.App.activate()` path as the **Open Authenticator** entry |
| Provider gate returns empty (locked) **with the popup already open** | ✅ automatic 1 s tick cleared the rows and showed "No codes available. Authenticator is locked or has no accounts." |
| Real passphrase-protected instance (current re-gate code): popup open while locked | ✅ `rowCount:0`, "No codes available. Authenticator is locked or has no accounts." (`menuOpen:true`) |
| Real instance: lock while a code is revealed (popup already open) | ✅ `revealed:true, code:"482911"` → next tick `rowCount:0`, locked status, `revealed:[]` |
| Real instance: fresh popup while still locked | ✅ close/reopen → `rowCount:0`, locked status, no code |
| Real instance: unlock restores list + live code | ✅ `rowCount:10`, `revealed:["707060"]` after typing the passphrase |
| Recovery after an empty/error state | ✅ list repopulates once the provider answers again |
| Clean `disable()` | ✅ refresh timer removed, rows destroyed, every owned reference (`_button`, `_entry`, `_section`, …) set to `null`, no error; re-enable returns to ACTIVE |
| Closing the popup clears codes | ✅ rows destroyed, old row `_code=null`, `revealed=false` |
| Search/rows restyle matches the Containers Manager language | ✅ nested 50.5 (`tools/inner_uix_test.sh`, 44/44): search row pill (`999px`) with the entry fill removed, account rows are `14px` cards, reveal toggle is a pill and turns the system accent `#3584e4` while a code is shown; text scale title `10pt` > subtitle/code `8.5pt` (monospace) |
| Revealed code shows the countdown bar | ✅ same run: the bar appears under the code, its accent fill tracks the text column and switches to `#e01b24` in the last 5 s; the row assumes the standard 30 s period until two observed code changes measure the account's real one. Once a change has been observed the countdown is anchored to it rather than re-derived from `epoch % period`, so the one-second polling slack in the measured period cannot turn into a wrong phase. The fill scales by the validity fraction inside a layout-sized track, so the first rendered frame uses the actual width without waiting for a polling tick. It also stays under the **Copied to clipboard** confirmation (the code itself is already dropped), keeps emptying there because the periodic tick now advances it, and stops at zero instead of refilling when the copied code expires |
| Code line fades and slides in and out | ✅ same run: the revealed token and the **Copied to clipboard** confirmation share one line (`_codeLine`) that animates opacity/translation on appear and disappear, and is hidden again once the confirmation clears (`codeLineVisible:1 → 0`) |
| Hidden rows keep no placeholder and the list clears the scrollbar | ✅ same run: a hidden row's code label is `visible=false`, and the list actor keeps a `10px` right gutter (`get_padding(RIGHT)`), so the scrollbar column no longer cuts into the card border and rounded corner |
| Restyle did not alter state behaviour | ✅ same run: rows render, reveal toggles, closing drops every row |
| Preferences reach the Shell UI | ✅ nested 50.5 (`tools/inner_prefs_test.sh`, 26/26): panel icon, sorting, provider-name visibility, row density, search fields, digit grouping, countdown bar, list height, open-app button/icon, search focus, close-after-copy and both shortcuts following their schema changes all read the schema and change the popup |
| No global D-Bus filter / no notification interception | ✅ (source scan); no crash in the nested session |

Exact evidence for the main flow (nested shell, `GetResultMetas` direct call at
the same moment):

```
{"rows":1,"names":["test@example.com"],"providers":["OTP Panel Test"],
 "revealed":[false],"codeLine":"hidden","statusVisible":false,"menuOpen":true}
{"revealed":true,"code":"814033","label":"814033"}
direct provider: clipboardText 814033
clipboard after click: 791575  (equals provider code 791575)
```

Re-verified on 2026-09-29 in a nested GNOME Shell 50.5 after the review
cleanup (see `REVIEW.md`): with 10 real accounts, open → reveal → copy → close →
`disable()` → `enable()` → open again listed all 10 rows, the code was cleared
by the copy, `_button` was `null` after `disable()`, and no JS error was logged.

Re-verified again on 2026-09-29 against the **current availability re-gate**
(`_fetchFreshMeta` / `_tick` post-fetch gate) on a real passphrase-protected
instance in a nested Shell 50.5, all 10 real accounts through `provider_proxy.js`:

```
unlocked, code shown:  {"rowCount":10,"status":null,"revealed":["482911"]}
lock via app.lock:      gate -> [], observer -> {"rowCount":0,
                        "status":"No codes available. Authenticator is locked or has no accounts.",
                        "revealed":[]}
fresh popup, locked:    {"rowCount":0,"status":"No codes available. Authenticator is locked or has no accounts.","revealed":[]}
unlock (passphrase):    gate -> 10 ids, observer -> {"rowCount":10,"status":null,"revealed":["707060"]}
```

Re-verified on 2026-09-30 in a nested GNOME Shell 50.5 with the fake provider
(`OTP_PROVIDER=fake_provider.js`) for the popup layout change: the row cards keep
a `10px` right gutter in front of the scrollbar, so its handle no longer touches
the card border and rounded corner; hidden rows render no code line at all; and
the countdown bar stays under the **Copied to clipboard** confirmation for
`COPY_FEEDBACK_MS` before label and bar clear together, continuing to empty
while it is shown rather than freezing (the copied row is no longer revealed, so
the periodic tick updates it explicitly).
`tools/inner_uix_test.sh` (44/44), `tools/inner_prefs_test.sh` (26/26),
`tools/inner_large_list_test.sh` (6/6, 200 accounts) and
`tools/inner_race_test.sh` (26/26) all pass on the same code. The UI run also
checks, with a faked `Date.now`, that a 60 s account seen one polling tick late
is anchored to the observed change (not re-phased from `epoch % 59 s`) and that
a copied code's bar stops at zero once it expires.

The countdown fixes were re-verified on 2026-09-30 with the fake provider in a
nested GNOME Shell. The seven additional UI checks cover a second copy across
a rollover while the first confirmation is visible (29 s left for the new
code), a copy after the confirmation clears with an inferred 59 s period
(54.1 s left from the observed phase rather than 18 s from epoch modulo), and
the absence of a retained code after each copy. Dropping the code preserves
only its timing anchor and period; a new confirmation replaces the previous
expiry, and clearing the row resets both timing fields.

The first-render countdown jump was reproduced and fixed on 2026-09-30 with
a persistent 1280×720 virtual monitor in the nested Shell. At a frozen 50%
validity, the previous pixel-width implementation drew a 48 px fill from the
96 px pre-layout column; after layout the track was 219 px wide, and the next
tick changed the fill to 110 px. The earlier synchronous first-frame check
missed this because it inspected actors before layout, and the headless
harness had no monitor. The track now uses `St.Bin` with an expanding fill
scaled by the validity fraction, without setting actor widths from pre-layout
measurements. `tools/inner_uix_test.sh` passes 47/47 checks with the monitor,
including the rendered 50% fill before polling and stable geometry after the
first explicit tick.

The GSettings-based preferences were added and verified in the same nested
shell: `metadata.json` declares the schema, `scripts/sync-extension.sh` compiles
it, and `tools/inner_prefs_test.sh` drives every key through the extension's own
settings object and checks the resulting UI/behaviour (panel icon, row order,
subtitle visibility, compact row height, search-field scoping, grouped code,
hidden countdown, 12 em list height for 3 rows, open-app icon and button, caret
focus on/off, popup close after copy, and both shortcuts following their
schema changes). The schema holds UI preferences only; no account name or code is
written to it.

The scrollbar geometry was also checked directly against the pixels of a real
session screenshot: before the gutter the card's right border sat at x=175 with
the scrollbar handle starting at x=176 (zero gap); the gutter is what gives the
card its clearance.

A real instance with a passphrase is required to run this: Authenticator 4.6.2
enables its `lock` action only when `has_set_password` is true, so a completely
unprotected instance cannot be locked over D-Bus.

### 2.3 What remains unverified

> Tracked in `docs/OPEN_ITEMS.md` (OTP-001 … OTP-006), with priorities and
> closure steps.

- ~~A real passphrase-protected (locked) Authenticator.~~ **Closed** (OTP-001):
  verified on a real passphrase-protected instance on 2026-09-29 — see §2.2 and
  `docs/OPEN_ITEMS.md`. The lock was triggered with the app's own `app.lock`
  action over D-Bus and undone by typing the passphrase, exercising the 1 s
  availability gate in both directions with the popup open.
- **`LaunchSearch` / `ActivateResult` from the extension.** Authenticator Companion copies the
  code itself instead of relying on Shell's result activation, so these methods
  are not used. The **Open Authenticator** entry and the open-app shortcut use
  `Shell.AppSystem` / `Shell.App.activate()`; their
  launch was not exercised end-to-end in the headless session.
- **Non-Flatpak packaging.** Only the Flatpak build was tested.
- **Very large account lists.** Closed by `tools/inner_large_list_test.sh`
  (200 accounts, filter, reveal, close) in the nested Shell 50.5; see
  `docs/OPEN_ITEMS.md` OTP-004. Multiple providers are not a distinct path:
  `description` is only a string in the metadata.
- ~~The final installed instance in the current login session.~~ **Closed**
  (OTP-005): after logout/login the installed copy was `ACTIVE`, the sync script
  installed the shipped files and reloaded it without errors, and the popup
  listed all 10 real accounts — see `docs/OPEN_ITEMS.md`.

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

# 4. deterministic lock / delayed-reply race test against tools/fake_provider.js
rm -rf /tmp/otp-fake && mkdir -p /tmp/otp-fake && printf 'fake:1\n' > /tmp/otp-fake/ids && echo 111111 > /tmp/otp-fake/code
OTP_PROVIDER=fake_provider.js ./tools/nested_env.sh tools/inner_race_test.sh

# 5. large-list stress test (200 accounts) against the same fake provider
rm -rf /tmp/otp-fake && mkdir -p /tmp/otp-fake
OTP_PROVIDER=fake_provider.js ./tools/nested_env.sh tools/inner_large_list_test.sh

# 6. UI restyle regression test (search pill, account cards, accent reveal toggle)
rm -rf /tmp/otp-fake && mkdir -p /tmp/otp-fake && printf 'fake:1\n' > /tmp/otp-fake/ids && echo 111111 > /tmp/otp-fake/code
OTP_PROVIDER=fake_provider.js ./tools/nested_env.sh tools/inner_uix_test.sh
```

`tools/` also contains `provider_proxy.js`, `fake_provider.js` and the test-only
`unsafe_helper` extension; they are not shipped with Authenticator Companion.

## 4. Adversarial race verification (fake provider)

`tools/inner_race_test.sh` runs against `tools/fake_provider.js`, a minimal
SearchProvider2 implementation that mirrors Authenticator 4.6.2: `GetResultMetas`
returns codes even while the control file marks the app locked, and replies can be
delayed on demand. Clipboard writes are recorded by patching `St.Clipboard` in the
shell, so a code reaching the clipboard is visible without a real clipboard.

Run inside an isolated nested GNOME Shell 50.5 (see the command in §3). Result of
the run on 2026-09-29 (re-run after the U01/U08 hardening), one fake account
(`fake:1`, code `111111`):

| Check | Observed |
|---|---|
| A. reveal shows the current code | ✅ code `111111`, row revealed, accessible name "Hide code" |
| B. copy writes the code and drops it | ✅ one clipboard write, row code cleared, accessible name "Show code" |
| C. lock before a copy of a cached id (H02) | ✅ no clipboard write, no code shown |
| D. lock while a reveal's `GetResultMetas` is in flight (H01) | ✅ no code shown, row not revealed |
| E. menu close while a delayed copy is in flight (H16) | ✅ no clipboard write, menu closed |
| F. slow older reveal followed by a fast copy (H03) | ✅ copy wins, older reveal does not restore the code |
| G. `disable()` while delayed reveal/copy are in flight, then `enable()` | ✅ no clipboard write, `_button`/`_service` null, re-enable lists and reveals again |
| I. malformed metadata (missing `name`) | ✅ no rows, "Unexpected response from Authenticator." status, the JS error is logged exactly once in 10 s, and the popup recovers when the provider is repaired |
| J. open-app shortcut | ✅ activates the app, closes the popup, and writes no D-Bus call to the app's own bus |

`TOTAL pass=26 fail=0`. The only shell-log error is the single
`[authenticator-companion]` line logged on purpose by case I; cases A–H and J
produce none. The real-provider smoke test (open → reveal → copy with the
10-account host instance through `provider_proxy.js`) also passed with no errors.

### 4.1 Residual race the extension cannot close

The extension now re-checks `GetInitialResultSet` before and after every reveal and
copy, and every second while the popup is open, but `GetResultMetas` itself does not
check the lock. A lock that completes between the final availability check and the
clipboard/display update is therefore not revoked by the client. Closing that window
completely requires a lock check inside Authenticator's `GetResultMetas`; it is
tracked as OTP-006 in `docs/OPEN_ITEMS.md`.

# Authenticator Companion

A GNOME Shell 50 **companion extension** for
[GNOME Authenticator](https://gitlab.gnome.org/World/Authenticator)
(`com.belmoussaoui.Authenticator`) that shows the accounts already configured in
the app in the top panel and copies the current one-time password with a single
click.

Authenticator remains the **only** source of accounts. The extension never
imports them, never keeps a parallel database and never reads secrets from the
keyring: it only asks Authenticator's own D-Bus Search Provider for the accounts
and the current codes.

## A companion extension, not a standalone app

Authenticator Companion is a **companion extension** for GNOME Authenticator. It
has no OTP engine of its own: it does not store accounts, does not import them
and does not generate codes. It is a thin, read-only panel front-end for the
accounts and codes that Authenticator already manages.

Because of that, the extension works **exclusively if Authenticator is present
and reachable** on the session bus:

- **Authenticator installed and unlocked** → accounts are listed and codes can be
  revealed and copied.
- **Authenticator installed but locked** → the Search Provider gate returns an
  empty list, so the popup shows no codes (see
  [passphrase note](#authenticator-passphrase-and-extension-performance)).
- **Authenticator not installed** → the extension still loads and its panel icon
  appears, but the popup only reports that the app is missing and stays inert. It
  cannot import accounts, find another backend or work in a standalone mode.
- **Authenticator removed** → the extension becomes permanently non-functional,
  by design.

There is no bundled copy of the data and no fallback path: uninstalling or
breaking Authenticator disables Authenticator Companion. Conversely, the
extension can never be more available, more complete or more reliable than the
app it wraps.

## Requirements

- GNOME Shell 50
- GNOME Authenticator (`com.belmoussaoui.Authenticator`), any packaging
  (Flatpak is the tested one)
- The app running (or startable via D-Bus activation) and **unlocked**
- At least one account configured in Authenticator

### Authenticator passphrase and extension performance

How well Authenticator Companion behaves depends directly on how Authenticator is
configured. Performance is best when **no passphrase is set** on Authenticator:

- **No passphrase (recommended).** Authenticator starts unlocked, so the D-Bus
  Search Provider can start it in the background on demand and return codes
  immediately. The extension is self-sufficient: open the popup, reveal or copy a
  code, done. Authenticator does not need to be open in the foreground.
- **Passphrase set (degraded).** Authenticator starts locked and the provider
  returns an empty result set until the app is unlocked. The extension then
  cannot fetch anything on its own: you must **go through the Authenticator app**,
  open it, type the passphrase and **keep it open and unlocked** for codes to be
  available. If the app auto-locks or is closed again, the panel list empties at
  the next availability check (~1 s) and stays empty until you unlock it again.

In short: without a passphrase the extension is fast and hands-off; with a
passphrase it is only a shortcut to an Authenticator session that you have to
keep alive yourself. This is a constraint of Authenticator's Search Provider API,
not a configurable behaviour of Authenticator Companion.

## How it works

GNOME Authenticator exposes the standard GNOME search interface on the session
bus (see `docs/VERIFICATION.md` for the full analysis):

| | |
|---|---|
| Bus name | `com.belmoussaoui.Authenticator.SearchProvider` |
| Object path | `/com/belmoussaoui/Authenticator/SearchProvider` |
| Interface | `org.gnome.Shell.SearchProvider2` |
| Activation | D-Bus activatable (`--gapplication-service`, Flatpak export) |

The extension creates one asynchronous `Gio.DBusProxy` to that service and uses
two read-only methods:

- `GetInitialResultSet([''])` — lists the account identifiers. While the app is
  locked, Authenticator deliberately returns an empty set.
- `GetResultMetas([id, …])` — returns each account's name, its provider name and
  the current code as `clipboardText`.

No global D-Bus filter is installed (`Gio.DBus.session.add_filter()` is
forbidden: it crashes GNOME Shell 50 devkit sessions) and notifications are not
intercepted.

The button next to the search field does not touch the Search Provider: it
brings Authenticator's own window to the front by activating the app through
`Shell.AppSystem` / `Shell.App.activate()`, the same path as the
**Open Authenticator** entry. It does not read or write any account data, and
it is a no-op when Authenticator is not installed.

## Installation

```sh
# from this repository (installs the shipped files and compiles the UI schema)
./scripts/sync-extension.sh
# or, for a packed bundle:
gnome-extensions install authenticator-companion@giaffa86.shell-extension.zip
```

GNOME Shell 50 only enumerates extensions at startup, so after installing the
extension for the first time you must log out and back in once (or restart the
shell) before it appears in `gnome-extensions list`. Then enable it:

```sh
gnome-extensions enable authenticator-companion@giaffa86
```

The extension is **not** published or uploaded to extensions.gnome.org.

### Upgrading from `otp-panel@giaffa86`

The extension was previously named **OTP Panel** with the UUID
`otp-panel@giaffa86`. The UUID change makes GNOME Shell treat it as a different
extension, so remove the old copy and its enabled state before installing the new
one:

```sh
gnome-extensions uninstall otp-panel@giaffa86
rm -rf ~/.local/share/gnome-shell/extensions/otp-panel@giaffa86
# then install as above and log out / back in once
```

## Usage

- Click the key icon in the top panel.
- The popup lists every account; a hidden account shows no code line at all.
- Use the eye button to reveal the current code; it is re-fetched every second
  while it is shown, so it stays current across a code rollover.
- A shown code has a thin countdown bar under it: the accent fill empties over
  the TOTP period and turns red in its last 5 seconds. The standard 30 s period
  is assumed; the bar follows the account's real period once two observed code
  changes have measured it, and is anchored to the latest observed change so
  the polling slack in the measurement cannot skew it. The bar stays under the
  "Copied to clipboard" confirmation too, for the code that was just copied,
  and it stops at zero once that code expires instead of refilling.
  Copying again updates the bar for the newly copied code, including across a
  rollover.
- Revealing a code and the "Copied to clipboard" confirmation both fade and
  slide their line into place instead of popping; the confirmation stays for
  four seconds.
- Click an account row to copy the current code to the clipboard.
- Type in the search field to filter by account or service name. Opening the
  popup puts the caret in the field automatically (this can be turned off in the
  preferences).
- Press the popup shortcut (default **Super+Shift+A**) to open or close the popup
  without reaching for the panel.
- The open-app button next to the search field brings Authenticator's window
  to the front (it is shown only while the app is unlocked; the same action is
  offered as an **Open Authenticator** entry when the app is unavailable).
- If Authenticator is locked or has no accounts, the popup says so and offers an
  **Open Authenticator** entry.
- If Authenticator is **not installed at all**, the extension still loads and the
  panel icon appears, but the popup reports that it is not installed and shows no
  open-app entry. It stays inert until the app is available.

## Preferences

The extension ships a preferences window (`prefs.js` + a GSettings schema) for
presentation and workflow only. It never stores accounts or codes.

- **Behaviour** — focus the search field on open; close the popup after copying
  a code.
- **Appearance** — pick the top-panel icon; sort accounts (as returned by
  Authenticator, by account name, by provider name); show/hide the provider
  name; row density (comfortable or compact); which fields the search matches
  (name and provider, name only, provider only); group the revealed code in
  blocks of three digits; show/hide the validity countdown bar; number of
  account rows the list shows without scrolling; show/hide the open-app button
  and pick its icon.
- **Shortcuts** — the accelerator that opens or closes the popup, and a second
  one that brings Authenticator's window to the front.

Open it from GNOME Extensions (the gear next to *Authenticator Companion*) or:

```sh
gnome-extensions prefs authenticator-companion@giaffa86
```

Changing a preference while the popup is open applies immediately: the popup
rebuilds its rows from the provider reply (names and the current code are
re-fetched, never cached from GSettings).

## Security and privacy model

- **Single source of truth.** Accounts and codes come only from Authenticator's
  Search Provider D-Bus API. The extension does not read the keyring, the
  app's database, or Flatpak permissions.
- **Preferences are UI-only.** The GSettings schema carries sorting,
  appearance, behaviour and the popup shortcut, and nothing else: never
  accounts, account identifiers, provider names or codes, and never the search
  text. Codes are never written to GSettings, files, logs, notifications or a
  database.
- **Minimal in-memory lifetime.** Codes are kept in memory only while the popup
  is open and only for rows that are revealed. Closing the popup, locking the
  app, or rebuilding the account list clears them, and a copied code is dropped
  from the extension's memory immediately after it reaches the clipboard. The
  extension does **not** clear the system clipboard: the copied code stays in
  the `CLIPBOARD` selection until it is overwritten, survives an Authenticator
  lock, and is readable by clipboard-history tools. Clearing the clipboard
  itself is left to the user and the desktop.
- **Reduced exposure.** Only the account identifiers returned by the current
  availability check are ever passed to `GetResultMetas`. Because that method
  does not itself check the lock state, the extension re-checks availability
  (`GetInitialResultSet`) before and after every reveal and copy, and every
  second while the popup is open, so a lock that happens before the code is
  shown or copied drops the code instead of displaying it.
- **Residual provider-side race.** A lock that lands between the extension's
  final availability check and the clipboard/display update can still let one
  code through, because Authenticator's `GetResultMetas` ignores the lock.
  Closing that window completely requires the provider to enforce the lock
  inside `GetResultMetas`; the extension alone cannot. This limit is tracked in
  `docs/OPEN_ITEMS.md` (OTP-006).
- **Clipboard only on request.** A code is fetched fresh and copied only when
  the user clicks a row.
- **No D-Bus filter / no notification hooking.** The call is a targeted,
  asynchronous request to one well-known service.

## Known limitations

- The extension cannot distinguish "Authenticator is locked" from "Authenticator
  has no accounts": both produce an empty result set from the Search Provider,
  so both show the same status message.
- While Authenticator is not running, asking for accounts starts it in the
  background (D-Bus activation). This is how the platform exposes the data.
- The Search Provider returns codes for every account whenever the account list
  is fetched (the API has no name-only query). The extension discards those
  codes immediately and only keeps the ones the user reveals.
- If Authenticator is missing or unreachable, the popup keeps retrying roughly
  every 5 s (instead of once per second) so it recovers on its own as soon as the
  app becomes available again.
- With a passphrase set on Authenticator, the extension is only as useful as the
  unlocked Authenticator session it depends on: locked means no accounts and no
  codes, and the app has to be opened, unlocked and kept open (see
  [passphrase note](#authenticator-passphrase-and-extension-performance)).
- Because Authenticator's `GetResultMetas` does not check the lock state, a very
  narrow race remains: if the app locks between the extension's final
  availability check and the clipboard/display update, that one response is not
  revoked. The extension re-checks as late as it can; closing the window fully
  needs a provider-side lock check (see `docs/OPEN_ITEMS.md` OTP-006).
- A passphrase-protected (locked) Authenticator instance was exercised end-to-end
  in a nested shell; see `docs/VERIFICATION.md` §2.2 for exactly what was and was
  not verified, and `docs/OPEN_ITEMS.md` for the tracked item (OTP-001, closed).
- A copied code remains in the system clipboard until it is overwritten; the
  extension cannot and does not clear it (see the security model above).

## Development / testing

`tools/` contains the harness used for the runtime verification:

- `provider_proxy.js` — re-exports Authenticator's Search Provider on a private
  D-Bus session so an isolated nested GNOME Shell can reach the running app.
- `nested_env.sh` — starts an isolated headless GNOME Shell 50 with the
  extension and the proxy.
- `unsafe_helper/` — test-only helper extension that enables
  `global.context.unsafe_mode` so `org.gnome.Shell.Eval` can drive the tests.
- `atspi_*.py` — small AT-SPI helpers used during reconnaissance.

These files are not part of the shipped extension.

# OTP Panel

A GNOME Shell 50 extension that shows the accounts already configured in
[GNOME Authenticator](https://gitlab.gnome.org/World/Authenticator)
(`com.belmoussaoui.Authenticator`) in the top panel and copies the current
one-time password with a single click.

Authenticator remains the **only** source of accounts. The extension never
imports them, never keeps a parallel database and never reads secrets from the
keyring: it only asks Authenticator's own D-Bus Search Provider for the accounts
and the current codes.

## Requirements

- GNOME Shell 50
- GNOME Authenticator (`com.belmoussaoui.Authenticator`), any packaging
  (Flatpak is the tested one)
- At least one account configured and unlocked in Authenticator

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

## Installation

```sh
# from this repository
cp -r . ~/.local/share/gnome-shell/extensions/otp-panel@giaffa86
# or, for a packed bundle:
gnome-extensions install otp-panel@giaffa86.shell-extension.zip
```

GNOME Shell 50 only enumerates extensions at startup, so after installing the
extension for the first time you must log out and back in once (or restart the
shell) before it appears in `gnome-extensions list`. Then enable it:

```sh
gnome-extensions enable otp-panel@giaffa86
```

The extension is **not** published or uploaded to extensions.gnome.org.

## Usage

- Click the key icon in the top panel.
- The popup lists every account; codes are masked (`••••••`) until requested.
- Use the eye button to reveal the current code (with a countdown).
- Click an account row to copy the current code to the clipboard.
- Type in the search field to filter by account or service name.
- If Authenticator is locked or has no accounts, the popup says so and offers an
  **Open Authenticator** entry.
- If Authenticator is **not installed at all**, the extension still loads and the
  panel icon appears, but the popup reports that it is not installed and shows no
  open-app entry. It stays inert until the app is available.
- The revealed code refreshes automatically when its TOTP period expires.

## Security and privacy model

- **Single source of truth.** Accounts and codes come only from Authenticator's
  Search Provider D-Bus API. The extension does not read the keyring, the
  app's database, or Flatpak permissions.
- **No persistence.** Codes are never written to GSettings, files, logs,
  notifications or a database. `metadata.json` declares no settings schema.
- **Minimal in-memory lifetime.** Codes are kept in memory only while the popup
  is open and only for rows that are revealed. Closing the popup clears them,
  and a copied code is dropped immediately after it reaches the clipboard.
- **Reduced exposure.** Only the account identifiers returned by the current
  availability check are ever passed to `GetResultMetas`. Because that method
  does not itself check the lock state, the extension re-checks availability
  (`GetInitialResultSet`) every second while the popup is open, so a lock that
  happens with the popup already open still clears the list and the codes.
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
- No passphrase-protected (real locked) Authenticator instance was exercised
  end-to-end in this environment; see `docs/VERIFICATION.md` for exactly what was
  and was not verified, and `docs/OPEN_ITEMS.md` for the tracked item (OTP-001)
  and how to close it.

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

# Tracked open items

Known limitations that were **declared but not fully closed** during the
implementation. They are recorded here so they stay tracked instead of getting
lost. `docs/VERIFICATION.md` §2.3 is the evidence source.

| ID | Item | Priority | Status |
|---|---|---|---|
| OTP-001 | Real passphrase-protected (locked) Authenticator not exercised end-to-end | High | **Open** |
| OTP-002 | `LaunchSearch` / `ActivateResult` not used by the extension | Low | Accepted |
| OTP-003 | Non-Flatpak packaging not tested | Low | Open |
| OTP-004 | Large account lists / multiple providers not stress-tested | Low | Open |
| OTP-005 | Installed copy in the live login session not exercised (needs next login) | Medium | Open |

---

## OTP-001 — Real passphrase-locked Authenticator not verified end-to-end

**Declared in:** `docs/VERIFICATION.md` §2.3 (first bullet) and §1.3.

**What is affected:** the requirement *"Rispetta lo stato di blocco dell'app
anche se il menu era già aperto"* — the extension must not show codes while
Authenticator is locked.

**Why it is still open.** A passphrase-protected Authenticator could not be
produced in this environment:

- no passphrase was configured in the test instance;
- the app's Preferences password page could not be driven automatically — GTK4
  text entries are not exposed through AT-SPI here, and AT-SPI keyboard
  synthesis did not deliver input on Wayland.

**What is already verified (partial closure).**

- Source contract: `InitialResultSet` returns `[]` while `is_locked()`, and
  `ResultMetas` does **not** check the lock state (upstream
  `src/application.rs`, documented in `docs/VERIFICATION.md` §1.3).
- Runtime: OTP Panel re-checks the availability gate every 1 s while the popup is
  open. Forcing the provider to return the same empty set it returns while locked
  cleared the rows and showed "No codes available. Authenticator is locked or has
  no accounts." with the popup already open — even with a code revealed.

**How to close it.**

1. In Authenticator, set a passphrase (Preferences → *Create Password*).
2. Lock the app (`Ctrl+L`, the lock action, or let auto-lock fire).
3. With OTP Panel's popup open and a code revealed, trigger the lock; confirm the
   rows are cleared and the locked status appears within ~1 s.
4. Re-open the popup while still locked and confirm no codes are listed.
5. Unlock Authenticator and confirm the list and codes come back.
6. Also confirm codes do not survive a Shell restart while the app is locked.

**Closure criteria.** Step 3 shows no code and no stale row after locking, and
step 5 restores data — observed on a real passphrase-protected instance.

**Note.** Because `GetResultMetas` ignores the lock state, the gate
(`GetInitialResultSet`) is the only safe source of truth; do not replace it with
a direct `GetResultMetas` call for cached ids.

---

## OTP-002 — `LaunchSearch` / `ActivateResult` not used

OTP Panel copies codes itself and offers an "Open Authenticator" entry, so these
two Search Provider methods are unused. Accepted by design; no action.

## OTP-003 — Non-Flatpak packaging not tested

Only the Flathub Flatpak build (4.6.2) was used. A distro-packaged
Authenticator should expose the same service; verify if needed.

## OTP-004 — Large account lists not stress-tested

Runtime tests used a single account. Check scrolling, filtering and the 1 s
refresh with many accounts and providers.

## OTP-005 — Installed copy in the live login session not exercised

GNOME Shell 50 enumerates extensions only at startup, so the copy installed in
`~/.local/share/gnome-shell/extensions/otp-panel@giaffa86` is picked up after the
next login. The runtime tests used a fresh nested Shell 50.3 that loaded the same
code. Close by logging out/in once and confirming the panel button appears and
the menu works.

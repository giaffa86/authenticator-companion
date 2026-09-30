# Tracked open items

Known limitations that were **declared but not fully closed** during the
implementation. They are recorded here so they stay tracked instead of getting
lost. `docs/VERIFICATION.md` §2.3 is the evidence source.

| ID | Item | Priority | Status |
|---|---|---|---|
| OTP-001 | Real passphrase-protected (locked) Authenticator not exercised end-to-end | High | **Closed** |
| OTP-002 | `LaunchSearch` / `ActivateResult` not used by the extension | Low | Accepted |
| OTP-003 | Non-Flatpak packaging not tested | Low | Open |
| OTP-004 | Large account lists / multiple providers not stress-tested | Low | **Closed** |
| OTP-005 | Installed copy in the live login session not exercised (needs next login) | Medium | **Closed** |
| OTP-006 | Lock is not enforced inside the provider's `GetResultMetas`, leaving a narrow client-side race | High | **Open — needs provider fix or explicit acceptance** |

---

## OTP-001 — Real passphrase-locked Authenticator not verified end-to-end

**Declared in:** `docs/VERIFICATION.md` §2.3 (first bullet) and §1.3.

**What is affected:** the requirement *"Rispetta lo stato di blocco dell'app
anche se il menu era già aperto"* — the extension must not show codes while
Authenticator is locked.

**Status:** closed on 2026-09-29 against a real passphrase-protected instance
(see `docs/VERIFICATION.md` §2.2). The passphrase was set in the app
(Preferences → *Create Password*, auto-lock enabled) and the app was locked with
its own `app.lock` action over D-Bus
(`org.gtk.Actions.Activate "lock"` on `/com/belmoussaoui/Authenticator`) and
unlocked by typing the passphrase.

**Evidence (nested Shell 50.3, `org.gnome.Shell.Eval`, via
`tools/inner_locked_test.sh`).**

- Step 5 (unlock restores data) — popup open after unlocking:
  `rowCount:1`, `revealed:true`, `code:"115254"`, `status:null`.
- Step 3 (lock while a code is revealed) — lock triggered while
  `revealed:true, code:"115254"`; the next 1 s tick
  reported `rowCount:0, status:"No codes available. Authenticator is locked or has no accounts."`
  with `menuOpen:true`.
- Step 4 (fresh popup while locked) — after close/reopen with the popup still
  locked: `rowCount:0` and the same locked status.

**What is already verified (partial closure).**

- Source contract: `InitialResultSet` returns `[]` while `is_locked()`, and
  `ResultMetas` does **not** check the lock state (upstream
  `src/application.rs`, documented in `docs/VERIFICATION.md` §1.3).
- Runtime: Authenticator Companion re-checks the availability gate every 1 s while the popup is
  open. Forcing the provider to return the same empty set it returns while locked
  cleared the rows and showed "No codes available. Authenticator is locked or has
  no accounts." with the popup already open — even with a code revealed.

**How to close it.**

1. In Authenticator, set a passphrase (Preferences → *Create Password*).
2. Lock the app (`Ctrl+L`, the lock action, or let auto-lock fire).
3. With Authenticator Companion's popup open and a code revealed, trigger the lock; confirm the
   rows are cleared and the locked status appears within ~1 s.
4. Re-open the popup while still locked and confirm no codes are listed.
5. Unlock Authenticator and confirm the list and codes come back.
6. Also confirm codes do not survive a Shell restart while the app is locked.

**Closure criteria.** Met: step 3 shows no code and no stale row after locking,
and step 5 restores data — observed on a real passphrase-protected instance.

**Re-verification (2026-09-29, current re-gate code).** Repeated against the
current `_fetchFreshMeta` / `_tick` post-fetch gate on a real passphrase-protected
instance in a nested Shell 50.5: unlocked code `482911`, lock → gate `[]` and
`rowCount:0` with the locked status, fresh popup while locked → no code, unlock →
`rowCount:10` and code `707060`. See `docs/VERIFICATION.md` §2.2. The current
instance only became lockable after the user set a passphrase, because
Authenticator 4.6.2 enables `app.lock` only when `has_set_password` is true.

**Note.** Because `GetResultMetas` ignores the lock state, the gate
(`GetInitialResultSet`) is the only safe source of truth; do not replace it with
a direct `GetResultMetas` call for cached ids.

---

## OTP-002 — `LaunchSearch` / `ActivateResult` not used

Authenticator Companion copies codes itself and offers an "Open Authenticator" entry, so these
two Search Provider methods are unused. Accepted by design; no action.

## OTP-003 — Non-Flatpak packaging not tested

Only the Flathub Flatpak build (4.6.2) was used. A distro-packaged
Authenticator should expose the same service; verify if needed.

## OTP-004 — Large account lists not stress-tested

**Status:** closed on 2026-09-29 with `tools/inner_large_list_test.sh` against
`tools/fake_provider.js` in a nested GNOME Shell 50.5. With 200 accounts all rows
were built (`rowCount=200`), the client-side filter reduced the list to the single
matching account, reveal showed the code on the filtered row, and closing the
popup dropped all rows and codes. `TOTAL pass=6 fail=0`, no extension errors.

Multiple *providers* are not meaningful for this extension: the account's
`description` is just a string in `GetResultMetas`, and the UI only groups no
accounts by provider. The 200-row run covers the scrolling/filtering path.

## OTP-005 — Installed copy in the live login session not exercised

**Status:** closed on 2026-09-29 on the user's live session. GNOME Shell 50
enumerates extensions only at startup, so the copy installed in
`~/.local/share/gnome-shell/extensions/authenticator-companion@giaffa86` is
picked up after the next login. This is standard Shell behavior, not an
extension code path.

**Evidence (live session, after logout/login).**

- After login the extension was listed and `gnome-extensions info` reported
  `Enabled: Yes`, `State: ACTIVE`; the panel button was present.
- `./scripts/sync-extension.sh` then installed the shipped files (hashes
  equal to the working tree) and reloaded the extension: it returned to
  `ACTIVE` with no `[authenticator-companion]` or JS error in the journal after
  the reload.
- The live provider gate (`GetInitialResultSet([''])` on the real
  `com.belmoussaoui.Authenticator.SearchProvider`) returned 10 account ids, and
  the user confirmed the popup lists all 10 accounts with Authenticator
  unlocked.

Reveal/copy behaviour on the same bytes is covered by the nested-shell race
test (`docs/VERIFICATION.md` §4).

---

## OTP-006 — Provider does not check the lock in `GetResultMetas`

**Declared in:** `docs/VERIFICATION.md` §4.1 and README "Security and privacy model".

**What is affected:** the guarantee "no code is shown or copied after Authenticator
locks". Authenticator 4.6.2 returns `[]` from `GetInitialResultSet` while locked,
but `GetResultMetas` has no lock check (upstream `src/application.rs`).

**What the extension does now:** before and after every reveal/copy it re-runs the
`GetInitialResultSet` gate, and it does the same every second while the popup is
open. A lock observed by any of those checks drops the code instead of displaying
or copying it, and a late reply from an older action is discarded.

**Residual risk:** if the app locks in the small interval between the extension's
final gate check and the `St.Clipboard`/label update, that single code still gets
through until the next tick clears it. No client can close this window, because
the only call that returns the code (`GetResultMetas`) ignores the lock.

**How to close it (provider side):** in Authenticator, make `GetResultMetas`
return no metadata (or omit `clipboardText`) when `is_locked()`, the same way
`GetInitialResultSet` already does. That makes the gate and the code read
consistent and removes the race.

**Closure criteria:** either the upstream provider enforces the lock in
`GetResultMetas`, or the limitation is explicitly accepted and the README/docs
keep stating it precisely.

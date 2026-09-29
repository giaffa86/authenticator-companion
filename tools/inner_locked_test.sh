#!/bin/bash
# Inner test (runs inside tools/nested_env.sh's private session): observe OTP
# Panel's behaviour while the real host Authenticator gets locked and unlocked.
#
# Behaviour:
#   - opens the popup once and keeps it open;
#   - prints "SNAP <json>" every second (rowCount / revealed code / status /
#     menuOpen);
#   - as soon as a row exists and nothing is revealed, reveals the first row, so
#     a code is always visible whenever the provider is unlocked;
#   - when /tmp/otp-signals/reopen appears, closes and reopens the popup and
#     prints "REOPENED <json>" (fresh popup while locked).
#
# The host drives the test by locking the app (D-Bus app.lock action) and by
# asking the user to unlock; this script only observes via the provider proxy.
#
# Usage: OTP001_OBSERVE_SECONDS=180 bash tools/inner_locked_test.sh
set -u
UUID=authenticator-companion@giaffa86
OBSERVE="${OTP001_OBSERVE_SECONDS:-180}"
SIGDIR="${OTP001_SIGDIR:-/tmp/otp-signals}"
mkdir -p "$SIGDIR"

eval_shell() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1" 2>/dev/null
}

# org.gnome.Shell.Eval JSON-serializes the returned value. The extension's
# implementation instance is `Main.extensionManager.lookup(uuid).stateObj`.
snap() {
  local out
  out=$(eval_shell "(() => {
    const ext = Main.extensionManager.lookup('$UUID')?.stateObj;
    if (!ext || !ext._button) return {err: 'noext'};
    const rows = (ext._rows || []).map(r => ({
      id: r.accountId, name: r.accountName, revealed: !!r.revealed,
      code: r._code, label: r._codeLabel ? r._codeLabel.text : null
    }));
    return {
      rows, rowCount: rows.length,
      status: (ext._statusItem && ext._statusItem.visible) ? ext._statusItem.label.text : null,
      menuOpen: !!(ext._button.menu && ext._button.menu.isOpen)
    };
  })()")
  echo "$out" | sed -n "s/^(true, '\(.*\)')$/\1/p"
}

open_menu()  { eval_shell "Main.extensionManager.lookup('$UUID').stateObj._button.menu.open(); 'ok'"  >/dev/null; }
close_menu() { eval_shell "Main.extensionManager.lookup('$UUID').stateObj._button.menu.close(); 'ok'" >/dev/null; }
reveal_first() {
  eval_shell "const e = Main.extensionManager.lookup('$UUID').stateObj; if (e._rows.length) e._reveal(e._rows[0]); 'ok'" >/dev/null
}

open_menu

# Observation loop.
for _ in $(seq 1 "$OBSERVE"); do
  s=$(snap)
  echo "SNAP $s"

  # Keep a code visible whenever there is a row to reveal.
  case "$s" in
    *'"rowCount":'[1-9]*) reveal_first;;
  esac

  if [ -f "$SIGDIR/reopen" ]; then
    rm -f "$SIGDIR/reopen"
    close_menu
    sleep 1
    open_menu
    echo "REOPENED $(snap)"
  fi
  sleep 1
done
echo "DONE"

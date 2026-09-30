#!/bin/bash
# Inner test (runs inside tools/nested_env.sh with OTP_PROVIDER=fake_provider.js).
#
# Reproduces the hostile-review races with a controllable provider:
#   A. baseline reveal
#   B. baseline copy
#   C. lock before a copy that uses a cached id           (H02)
#   D. lock during the metadata call of a reveal           (H01)
#   E. menu close during a delayed copy                    (H16)
#   F. older delayed reveal followed by a fast copy        (H03)
#   G. disable() during delayed reveal/copy, then enable()  (H05)
#   I. malformed metadata is visible, logged once, recovers (U01)
#   J. open-app shortcut: activates the app, closes the popup (T01/U08)
#
# Clipboard writes are recorded by patching St.Clipboard.set_text, so a code
# reaching the clipboard is visible without touching a real clipboard.
#
# Usage: OTP_PROVIDER=fake_provider.js ./tools/nested_env.sh tools/inner_race_test.sh
set -u

UUID=authenticator-companion@giaffa86
FAKE="${OTP_FAKE_DIR:-/tmp/otp-fake}"
PASS=0
FAIL=0
RESULTS=()

ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}

# The JS below always returns a JSON string, so Eval renders it as (true, '...').
jseval() {
    ev "$1" | sed -n "s/^(true, '\(.*\)')$/\1/p"
}

field() {
    python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('$1'))"
}

check() {
    if [ "$2" = "$3" ]; then
        RESULTS+=("PASS $1")
        PASS=$((PASS + 1))
    else
        RESULTS+=("FAIL $1 (expected=$2 actual=$3)")
        FAIL=$((FAIL + 1))
    fi
}

snap() {
    jseval "(() => {
        const ext = globalThis.__otpExt;
        const rows = (ext._rows || []).map(r => ({
            revealed: !!r.revealed,
            code: r._code === undefined ? null : r._code,
            copied: !!r._copied
        }));
        return {
            rowCount: rows.length,
            revealedCount: rows.filter(r => r.revealed).length,
            anyCode: rows.some(r => r.code !== null),
            anyCopied: rows.some(r => r.copied),
            codeText: (() => { const r = rows.find(x => x.code !== null); return r ? String(r.code) : ''; })(),
            revealAccessible: ext._rows.length ? ext._rows[0]._revealButton.accessible_name : '',
            writes: (globalThis.__otpWrites || []).join(','),
            status: ext._statusItem && ext._statusItem.visible ? ext._statusItem.label.text : null,
            launches: (globalThis.__otpLaunchCalls || []).length,
            menuOpen: !!(ext._button && ext._button.menu && ext._button.menu.isOpen),
            buttonNull: ext._button === null,
            serviceNull: ext._service === null,
            generation: ext._generation
        };
    })()"
}

open_menu() {
    ev "globalThis.__otpExt._button.menu.open(); 'ok'" >/dev/null
}
close_menu() {
    ev "globalThis.__otpExt._button.menu.close(); 'ok'" >/dev/null
}
reveal_first() {
    ev "const r = globalThis.__otpExt._rows[0]; if (r) r._revealButton.emit('clicked', r._revealButton); 'ok'" >/dev/null
}
copy_first() {
    ev "const r = globalThis.__otpExt._rows[0]; if (r) r.activate(null); 'ok'" >/dev/null
}
reset_writes() {
    ev "globalThis.__otpWrites = []; 'ok'" >/dev/null
}

lock() { : > "$FAKE/locked"; }
unlock() { rm -f "$FAKE/locked"; }
set_code() { echo "$1" > "$FAKE/code"; }
delay_first() { echo "$1" > "$FAKE/delay_first_ms"; }
clear_delay() { rm -f "$FAKE/delay_first_ms" "$FAKE/delay_ms"; }

wait_rows() {
    local want="$1" i s
    for i in $(seq 1 24); do
        s=$(snap)
        [ "$(echo "$s" | field rowCount)" = "$want" ] && return 0
        sleep 0.5
    done
    return 1
}

# Record clipboard writes instead of performing them.
ev "(() => {
    const St = imports.gi.St;
    globalThis.__otpExt = Main.extensionManager.lookup('$UUID').stateObj;
    globalThis.__otpWrites = [];
    St.Clipboard.prototype.set_text = function (type, text) {
        globalThis.__otpWrites.push(String(text));
    };
    return 'patched';
})()" >/dev/null

# Start from a clean fixture: a stale directory must not change the result.
rm -rf "$FAKE"
mkdir -p "$FAKE"
printf 'fake:1\n' > "$FAKE/ids"
unlock
set_code 111111
clear_delay

# --- A. baseline reveal -----------------------------------------------------
open_menu
if ! wait_rows 1; then
    RESULTS+=("FAIL setup: no rows for fake provider")
    FAIL=$((FAIL + 1))
else
    reveal_first
    sleep 0.8
    s=$(snap)
    check "A reveal shows code" "111111" "$(echo "$s" | field codeText)"
    check "A reveal marks row" "1" "$(echo "$s" | field revealedCount)"
    check "A reveal updates accessible name" "Hide code" "$(echo "$s" | field revealAccessible)"
fi

# --- B. baseline copy -------------------------------------------------------
reset_writes
copy_first
sleep 0.8
s=$(snap)
check "B copy writes code" "111111" "$(echo "$s" | field writes)"
check "B copy drops code" "False" "$(echo "$s" | field anyCode)"
check "B copy resets accessible name" "Show code" "$(echo "$s" | field revealAccessible)"

# --- C. H02: lock before a copy that uses the cached raw id ----------------
close_menu
sleep 0.3
open_menu
wait_rows 1 >/dev/null
reset_writes
lock
copy_first
sleep 1.5
s=$(snap)
check "C locked copy writes nothing" "" "$(echo "$s" | field writes)"
check "C locked copy keeps no code" "False" "$(echo "$s" | field anyCode)"

# --- D. H01: lock while GetResultMetas is in flight -------------------------
unlock
clear_delay
wait_rows 1 >/dev/null
reset_writes
delay_first 2500
reveal_first
sleep 0.4
lock
sleep 3.0
s=$(snap)
check "D lock during metas shows no code" "False" "$(echo "$s" | field anyCode)"
check "D lock during metas reveals nothing" "0" "$(echo "$s" | field revealedCount)"

# --- E. H16: menu close while a delayed copy is in flight -------------------
unlock
clear_delay
wait_rows 1 >/dev/null
reset_writes
delay_first 2500
copy_first
sleep 0.4
close_menu
sleep 3.0
s=$(snap)
check "E late copy after close writes nothing" "" "$(echo "$s" | field writes)"
check "E menu is closed" "False" "$(echo "$s" | field menuOpen)"

# --- F. H03: slow older reveal, fast newer copy -----------------------------
unlock
clear_delay
open_menu
wait_rows 1 >/dev/null
reset_writes
delay_first 2500
reveal_first
sleep 0.4
copy_first
sleep 3.5
s=$(snap)
check "F copy wins over older reveal" "111111" "$(echo "$s" | field writes)"
check "F older reveal does not restore code" "False" "$(echo "$s" | field anyCode)"
check "F older reveal does not reveal row" "0" "$(echo "$s" | field revealedCount)"

# --- G. disable during delayed actions, then enable -------------------------
clear_delay
reset_writes
delay_first 2500
reveal_first
sleep 0.2
delay_first 2500
copy_first
sleep 0.2
ev "globalThis.__otpExt.disable(); 'ok'" >/dev/null
sleep 3.0
s=$(snap)
check "G disable nulls button" "True" "$(echo "$s" | field buttonNull)"
check "G disable nulls service" "True" "$(echo "$s" | field serviceNull)"
check "G late copy after disable writes nothing" "" "$(echo "$s" | field writes)"

ev "globalThis.__otpExt.enable(); 'ok'" >/dev/null
sleep 0.5
open_menu
if wait_rows 1; then
    reset_writes
    reveal_first
    sleep 0.8
    s=$(snap)
    check "G re-enable lists rows" "1" "$(echo "$s" | field rowCount)"
    check "G re-enable reveal works" "111111" "$(echo "$s" | field codeText)"
else
    RESULTS+=("FAIL G re-enable lists rows")
    FAIL=$((FAIL + 1))
fi

# --- I. malformed metadata: visible error, logged once, recovery (U01) ----
LOG="${OTP_RUNTIME:-/tmp}/shell.log"
before=$(grep -c "\[authenticator-companion\]" "$LOG" 2>/dev/null || true)
unlock
clear_delay
printf 'acct:bad\n' > "$FAKE/ids"
: > "$FAKE/omit_name"
sleep 3
s=$(snap)
check "I malformed metadata shows no rows" "0" "$(echo "$s" | field rowCount)"
check "I malformed metadata shows a message" "Unexpected response from Authenticator." "$(echo "$s" | field status)"
sleep 7
after=$(grep -c "\[authenticator-companion\]" "$LOG" 2>/dev/null || true)
diff=$((after - before))
check "I malformed metadata logs exactly once" "1" "$diff"
# Repair the provider: the popup must recover instead of staying blank.
rm -f "$FAKE/omit_name"
printf 'fake:1\n' > "$FAKE/ids"
if wait_rows 1; then
    check "I malformed metadata recovers" "1" "$(snap | field rowCount)"
else
    RESULTS+=("FAIL I malformed metadata recovers")
    FAIL=$((FAIL + 1))
fi

# --- J. the open-app shortcut: activates the app, closes the popup (T01/U08) --
clear_delay
# Make the activation observable: return a fake Shell.App whose activate() is
# recorded, without needing a real .desktop entry in the nested shell.
ev "(() => {
    globalThis.__otpLaunchCalls = [];
    globalThis.__otpExt._lookupApp = () => ({ activate: () => globalThis.__otpLaunchCalls.push('activate') });
    return 'ok';
})()" >/dev/null

open_menu
wait_rows 1 >/dev/null
ev "globalThis.__otpLaunchCalls = []; 'ok'" >/dev/null
ev "const b = globalThis.__otpExt._appButton; b.emit('clicked', b); 'ok'" >/dev/null
sleep 0.5
check "J open-app shortcut activates the app" "1" "$(snap | field launches)"
check "J open-app shortcut closes the popup" "False" "$(snap | field menuOpen)"

# --- report -----------------------------------------------------------------
printf '%s\n' "${RESULTS[@]}"
echo "TOTAL pass=$PASS fail=$FAIL"

LOG="${OTP_RUNTIME:-/tmp}/shell.log"
if [ -f "$LOG" ]; then
    errors=$(grep -c -E "JS ERROR|TypeError|Unhandled|\[authenticator-companion\]" "$LOG" || true)
    echo "EXTENSION_ERROR_LINES=$errors (scenario I intentionally logs one)"
fi

[ "$FAIL" -eq 0 ]

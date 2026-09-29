#!/bin/bash
# Inner test (runs inside tools/nested_env.sh with OTP_PROVIDER=fake_provider.js).
#
# Stress test for a large account list (OTP-004): build the list, verify the
# rows are all there, filter client-side, reveal a filtered row, and confirm
# that closing the popup drops everything.
#
# Usage: OTP_PROVIDER=fake_provider.js ./tools/nested_env.sh tools/inner_large_list_test.sh
set -u

UUID=authenticator-companion@giaffa86
FAKE="${OTP_FAKE_DIR:-/tmp/otp-fake}"
COUNT="${OTP_LARGE_COUNT:-200}"
PASS=0
FAIL=0
RESULTS=()

ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}
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
            visible: !!r.visible
        }));
        const coded = rows.find(r => r.code !== null);
        return {
            rowCount: rows.length,
            visibleCount: rows.filter(r => r.visible).length,
            revealedCount: rows.filter(r => r.revealed).length,
            codeText: coded ? String(coded.code) : ''
        };
    })()"
}

wait_rows() {
    local want="$1" i s
    for i in $(seq 1 40); do
        s=$(snap)
        [ "$(echo "$s" | field rowCount)" = "$want" ] && return 0
        sleep 0.5
    done
    return 1
}

rm -rf "$FAKE"
mkdir -p "$FAKE"
echo 111111 > "$FAKE/code"
for i in $(seq 0 $((COUNT - 1))); do
    printf 'acct:%03d\n' "$i"
done > "$FAKE/ids"

ev "globalThis.__otpExt = Main.extensionManager.lookup('$UUID').stateObj; 'ok'" >/dev/null

ev "globalThis.__otpExt._button.menu.open(); 'ok'" >/dev/null
if wait_rows "$COUNT"; then
    RESULTS+=("PASS large list has $COUNT rows")
    PASS=$((PASS + 1))
else
    RESULTS+=("FAIL large list expected $COUNT rows: $(snap)")
    FAIL=$((FAIL + 1))
fi

# Client-side filter must hide everything but the exact match.
ev "globalThis.__otpExt._entry.set_text('acct:199'); 'ok'" >/dev/null
sleep 0.5
s=$(snap)
check "filter shows one row" "1" "$(echo "$s" | field visibleCount)"

# Reveal the single filtered row and confirm a code is shown.
ev "const e = globalThis.__otpExt; e._reveal(e._rows.find(r => r.visible)); 'ok'" >/dev/null
sleep 1.0
s=$(snap)
check "filtered reveal shows code" "111111" "$(echo "$s" | field codeText)"
check "filtered reveal marks one row" "1" "$(echo "$s" | field revealedCount)"

# Close must drop all rows and codes.
ev "globalThis.__otpExt._button.menu.close(); 'ok'" >/dev/null
sleep 0.5
s=$(snap)
check "close drops the large list" "0" "$(echo "$s" | field rowCount)"
check "close drops filtered code" "" "$(echo "$s" | field codeText)"

printf '%s\n' "${RESULTS[@]}"
echo "TOTAL pass=$PASS fail=$FAIL"

LOG="${OTP_RUNTIME:-/tmp}/shell.log"
if [ -f "$LOG" ]; then
    errors=$(grep -c -E "JS ERROR|TypeError|\[authenticator-companion\]" "$LOG" || true)
    echo "EXTENSION_ERROR_LINES=$errors"
fi

[ "$FAIL" -eq 0 ]

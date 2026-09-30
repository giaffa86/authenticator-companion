#!/bin/bash
# Inner test (runs inside tools/nested_env.sh with OTP_PROVIDER=fake_provider.js).
#
# UI regression check for the Containers-Manager-aligned styling: the search
# field is a pill, account rows are cards with a compact text scale, and the
# round reveal toggle turns the system accent while a code is shown.
#
# Usage: OTP_PROVIDER=fake_provider.js ./tools/nested_env.sh tools/inner_uix_test.sh
set -u
UUID=authenticator-companion@giaffa86
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
get() {
    python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('$1', ''))"
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
        const St = imports.gi.St;
        const ext = Main.extensionManager.lookup('$UUID').stateObj;
        const row = ext._rows[0];
        const node = a => a ? a.get_theme_node() : null;
        const radius = a => node(a) ? node(a).get_border_radius(St.Corner.TOPLEFT) : -1;
        const bgAlpha = a => node(a) ? node(a).get_background_color().alpha : -1;
        const bgRgb = a => {
            const c = node(a).get_background_color();
            return c.red + ',' + c.green + ',' + c.blue;
        };
        const fontSize = a => {
            const f = node(a) ? node(a).get_font() : null;
            return f ? f.get_size() : -1;
        };
        const fontFamily = a => {
            const f = node(a) ? node(a).get_font() : null;
            return f ? f.get_family() : '';
        };
        const entry = ext._entry;
        const searchRow = entry.get_parent();
        const reveal = row ? row._revealButton : null;
        return {
            rows: ext._rows.length,
            searchClass: searchRow.get_style_class_name(),
            searchRadius: radius(searchRow),
            searchBgAlpha: bgAlpha(searchRow),
            searchHeight: searchRow.get_height(),
            entryBgAlpha: bgAlpha(entry),
            cardClass: row ? row.get_style_class_name() : '',
            cardRadius: radius(row),
            cardBgAlpha: bgAlpha(row),
            cardHeight: row ? row.get_height() : -1,
            titleSize: fontSize(row && row._title),
            subtitleSize: fontSize(row && row._subtitle),
            codeSize: fontSize(row && row._codeLabel),
            codeFamily: fontFamily(row && row._codeLabel),
            revealRadius: radius(reveal),
            revealBgAlpha: bgAlpha(reveal),
            revealBgRgb: reveal ? bgRgb(reveal) : '',
            revealWidth: reveal ? reveal.get_width() : -1,
            revealHeight: reveal ? reveal.get_height() : -1,
            entryFocused: entry.clutter_text.has_key_focus() ? 1 : 0,
            revealed: row && row.revealed ? 1 : 0,
            copied: row && row._copied ? 1 : 0,
            codeLabelVisible: row && row._codeLabel.visible ? 1 : 0,
            codeLabelText: row ? row._codeLabel.text : '',
            listPadRight: row ? row.get_parent().get_theme_node().get_padding(St.Side.RIGHT) : -1,
            countdownVisible: row && row._countdownTrack.visible ? 1 : 0,
            codeLineVisible: row && row._codeLine.visible ? 1 : 0,
            countdownTrackWidth: row ? row._countdownTrack.width : -1,
            countdownBoxWidth: row ? row._title.get_parent().get_width() : -1,
            countdownFillWidth: row ? Math.round(row._countdownFill.width * row._countdownFill.scale_x) : -1
        };
    })()"
}

open_menu() {
    ev "Main.extensionManager.lookup('$UUID').stateObj._button.menu.open(); 'ok'" >/dev/null
}
close_menu() {
    ev "Main.extensionManager.lookup('$UUID').stateObj._button.menu.close(); 'ok'" >/dev/null
}

open_menu
state=""
for _ in $(seq 1 40); do
    state=$(snap)
    [ "$(echo "$state" | get rows)" -ge 1 ] 2>/dev/null && break
    sleep 0.5
done

check "account rows present" "yes" "$([ "$(echo "$state" | get rows)" -ge 1 ] && echo yes || echo no)"
check "search row class" "yes" "$(echo "$state" | get searchClass | grep -q 'authenticator-companion-search-row' && echo yes || echo no)"
check "search row is a pill" "999" "$(echo "$state" | get searchRadius)"
check "search field has no fill" "0" "$(echo "$state" | get entryBgAlpha)"
check "account row is a card" "14" "$(echo "$state" | get cardRadius)"
check "account row carries the item class" "yes" "$(echo "$state" | grep -q authenticator-companion-item && echo yes || echo no)"
check "hidden row shows no masked code line" "0" "$(echo "$state" | get codeLabelVisible)"
check "account list keeps a scrollbar gutter" "10" "$(echo "$state" | get listPadRight)"
check "reveal button is a pill" "999" "$(echo "$state" | get revealRadius)"
check "reveal button idle is transparent" "0" "$(echo "$state" | get revealBgAlpha)"
check "title larger than subtitle" "yes" "$([ "$(echo "$state" | get titleSize)" -gt "$(echo "$state" | get subtitleSize)" ] && echo yes || echo no)"
check "code matches subtitle size" "$(echo "$state" | get subtitleSize)" "$(echo "$state" | get codeSize)"
check "code is monospace" "monospace" "$(echo "$state" | get codeFamily)"
check "search row height is at least 34" "yes" "$([ "$(echo "$state" | get searchHeight)" -ge 34 ] && echo yes || echo no)"
check "account card keeps a compact height" "yes" "$([ "$(echo "$state" | get cardHeight)" -ge 44 ] && [ "$(echo "$state" | get cardHeight)" -le 90 ] && echo yes || echo no)"
check "reveal button is a round ~34px target" "yes" "$([ "$(echo "$state" | get revealWidth)" -ge 34 ] && [ "$(echo "$state" | get revealWidth)" -le 38 ] && [ "$(echo "$state" | get revealWidth)" = "$(echo "$state" | get revealHeight)" ] && echo yes || echo no)"

# Freeze validity at 50% and stop polling: the first actual rendered frame
# must use the newly allocated track width without waiting for a refresh.
firstframe=$(jseval "(() => {
    const ext = Main.extensionManager.lookup('$UUID').stateObj;
    imports.gi.GLib.source_remove(ext._refreshId);
    ext._refreshId = 0;
    const row = ext._rows[0];
    row._remainingMs = () => 15000;
    row.setCode('123456');
    row.setRevealed(true);
    return {fraction: row._countdownFill.scale_x};
})()")
check "countdown starts with the current validity fraction" "0.5" "$(echo "$firstframe" | get fraction)"
sleep 0.3
allocated=$(snap)
check "first rendered countdown matches the allocated track" "yes" \
    "$(echo "$allocated" | python3 -c 'import json,sys; s=json.load(sys.stdin); t=s["countdownTrackWidth"]; print("yes" if t > 0 and abs(s["countdownFillWidth"] - t / 2) <= 1 else "no")')"
ev "Main.extensionManager.lookup('$UUID').stateObj._rows[0].updateCountdown(); 'ok'" >/dev/null
sleep 1.2
aftertick=$(snap)
check "first countdown tick does not change the layout" "$(echo "$allocated" | get countdownTrackWidth)" "$(echo "$aftertick" | get countdownTrackWidth)"
check "first countdown tick keeps the same validity fraction" "$(echo "$allocated" | get countdownFillWidth)" "$(echo "$aftertick" | get countdownFillWidth)"
close_menu
sleep 0.3
open_menu
sleep 0.5

# Opening the popup must put the caret in the search field by itself.
sleep 0.5
focused=$(snap)
check "search is focused on open" "1" "$(echo "$focused" | get entryFocused)"
check "focused search row shows the focus class" "yes" "$(echo "$focused" | get searchClass | grep -q focused && echo yes || echo no)"

# Reveal through the real path so the code (and its countdown) populates.
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._reveal(e._rows[0]); 'ok'" >/dev/null
checked=""
for _ in $(seq 1 20); do
    checked=$(snap)
    [ "$(echo "$checked" | get countdownVisible)" = "1" ] && [ "$(echo "$checked" | get countdownTrackWidth)" -gt 0 ] && break
    sleep 0.5
done
check "revealed toggle uses the accent" "255" "$(echo "$checked" | get revealBgAlpha)"
check "countdown bar is shown with a revealed code" "1" "$(echo "$checked" | get countdownVisible)"
tkw=$(echo "$checked" | get countdownTrackWidth)
flw=$(echo "$checked" | get countdownFillWidth)
check "countdown fill tracks the track width" "yes" "$([ "$flw" -gt 0 ] && [ "$flw" -le "$tkw" ] && echo yes || echo no)"

warning=$(jseval "(() => {
    const row = Main.extensionManager.lookup('$UUID').stateObj._rows[0];
    const fill = row._countdownFill;
    const realNow = Date.now;
    Date.now = () => 29999000;
    row.updateCountdown();
    const on = fill.get_style_class_name().includes('warning');
    const c = fill.get_theme_node().get_background_color();
    Date.now = realNow;
    row.updateCountdown();
    return {on: on ? 1 : 0, rgb: c.red + ',' + c.green + ',' + c.blue};
})()")
check "countdown marks the last 5 seconds" "1" "$(echo "$warning" | get on)"
check "countdown switches to the warning colour" "224,27,36" "$(echo "$warning" | get rgb)"

# Copying replaces the code with a confirmation: the row drops the code, but
# the expiry bar must stay for the code that was just copied.
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._copy(e._rows[0]); 'ok'" >/dev/null
sleep 0.6
copied=$(snap)
check "copy shows the confirmation" "Copied to clipboard" "$(echo "$copied" | get codeLabelText)"
check "copied row drops the code" "0" "$(echo "$copied" | get revealed)"
check "copied row keeps the expiry bar" "1" "$(echo "$copied" | get countdownVisible)"
check "copied row animates the code line in" "1" "$(echo "$copied" | get codeLineVisible)"
# The copied row is no longer revealed, so only the periodic tick can advance
# its bar: this is the regression the longer-lived confirmation exposed.
sleep 2
moving=$(snap)
w0=$(echo "$copied" | get countdownFillWidth)
w1=$(echo "$moving" | get countdownFillWidth)
check "copied expiry bar keeps moving" "yes" "$([ "$w1" -lt "$w0" ] && echo yes || echo no)"
sleep 2.4
reset=$(snap)
check "confirmation clears itself" "0" "$(echo "$reset" | get codeLabelVisible)"
check "confirmation clears the expiry bar" "0" "$(echo "$reset" | get countdownVisible)"
check "confirmation animates the code line out" "0" "$(echo "$reset" | get codeLineVisible)"

# The measured period is only as exact as the 1 s polling that observes the
# changes. A 60 s account seen one second late must not be re-phased from
# `epoch % 59 s`; the bar is anchored to the observed change instead.
period=$(jseval "(() => {
    const row = Main.extensionManager.lookup('$UUID').stateObj._rows[0];
    const realNow = Date.now;
    Date.now = () => 1000000;
    row.forgetCode();
    row.setCode('111111');
    Date.now = () => 1001000;
    row.setCode('222222');
    Date.now = () => 1060000;
    row.setCode('333333');
    Date.now = () => 1060100;
    const remaining = Math.round(row._remainingMs());
    const ms = row._periodMs;
    Date.now = realNow;
    row.clearCode();
    return {period: ms, remaining: remaining};
})()")
check "measured period is adopted" "59000" "$(echo "$period" | get period)"
check "countdown is anchored to the observed change" "58900" "$(echo "$period" | get remaining)"

# A copied code that expires while the confirmation is still shown must keep
# the bar at zero instead of refilling at the rollover.
expired=$(jseval "(() => {
    const row = Main.extensionManager.lookup('$UUID').stateObj._rows[0];
    const realNow = Date.now;
    Date.now = () => 2000000;
    row.forgetCode();
    row.setCode('111111');
    row.setRevealed(true);
    row.flashCopied();
    row.forgetCode();
    const before = Math.round(row._remainingMs());
    Date.now = () => 2000000 + 40000;
    row.updateCountdown();
    const after = Math.round(row._remainingMs());
    Date.now = realNow;
    row.clearCopied();
    row.clearCode();
    return {before: before, after: after};
})()")
check "copied bar empties before expiry" "yes" "$([ "$(echo "$expired" | get before)" -gt 0 ] && echo yes || echo no)"
check "copied bar stops at zero after expiry" "0" "$(echo "$expired" | get after)"

# Copy again across a rollover while the previous confirmation is still shown.
recopied=$(jseval "(() => {
    const row = Main.extensionManager.lookup('$UUID').stateObj._rows[0];
    const realNow = Date.now;
    try {
        row.clearCode();
        Date.now = () => 1800000029000;
        row.flashCopied();
        row.forgetCode();
        Date.now = () => 1800000031000;
        const expired = row._remainingMs();
        row.flashCopied();
        row.forgetCode();
        return {expired, remaining: row._remainingMs(), code: row._code};
    } finally {
        Date.now = realNow;
        row.clearCode();
    }
})()")
check "previous copy expires before recopy" "0" "$(echo "$recopied" | get expired)"
check "recopy uses the new code's validity" "29000" "$(echo "$recopied" | get remaining)"
check "recopy keeps no code in memory" "None" "$(echo "$recopied" | get code)"

# Dropping the code must retain the timing anchor, including after the copy
# confirmation clears. An inferred 59 s period must never use epoch modulo.
anchoredCopy=$(jseval "(() => {
    const row = Main.extensionManager.lookup('$UUID').stateObj._rows[0];
    const realNow = Date.now;
    try {
        row.clearCode();
        Date.now = () => 1800000000000;
        row.setCode('111111');
        Date.now = () => 1800000060700;
        row.setCode('222222');
        Date.now = () => 1800000120100;
        row.setCode('333333');
        Date.now = () => 1800000120200;
        row.flashCopied();
        row.forgetCode();
        row.clearCopied();
        Date.now = () => 1800000125000;
        row.flashCopied();
        row.forgetCode();
        return {
            period: row._periodMs,
            remaining: row._remainingMs(),
            expiry: row._copyExpiryMs,
            code: row._code,
        };
    } finally {
        Date.now = realNow;
        row.clearCode();
    }
})()")
check "copy retains the observed period" "59000" "$(echo "$anchoredCopy" | get period)"
check "copy after confirmation uses the observed phase" "54100" "$(echo "$anchoredCopy" | get remaining)"
check "recopy retains the anchored expiry" "1800000179100" "$(echo "$anchoredCopy" | get expiry)"
check "anchored copies keep no code in memory" "None" "$(echo "$anchoredCopy" | get code)"

close_menu
sleep 0.5
check "closing drops the rows" "0" "$(snap | get rows)"

for line in "${RESULTS[@]}"; do echo "$line"; done
echo "RESULT pass=$PASS fail=$FAIL"
echo "accent rgb: unchecked=$(echo "$state" | get revealBgRgb) checked=$(echo "$checked" | get revealBgRgb)"
echo "layout: searchH=$(echo "$state" | get searchHeight) cardH=$(echo "$state" | get cardHeight) reveal=$(echo "$state" | get revealWidth)x$(echo "$state" | get revealHeight) boxW=$(echo "$checked" | get countdownBoxWidth) countdown=$(echo "$checked" | get countdownFillWidth)/$(echo "$checked" | get countdownTrackWidth)"
grep -iE "stylesheet|parsing|st-theme|css" "$OTP_RUNTIME/shell.log" 2>/dev/null | head -20
[ "$FAIL" -eq 0 ]

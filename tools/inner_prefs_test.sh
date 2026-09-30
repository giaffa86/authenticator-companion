#!/bin/bash
# Inner test (runs inside tools/nested_env.sh with OTP_PROVIDER=fake_provider.js).
#
# Preferences regression check: every schema key must actually reach the Shell
# UI. Settings are changed through the extension's own GSettings object so the
# change notification fires inside the nested session (the sandbox has no
# working keyfile file monitor).
#
# Usage: OTP_PROVIDER=fake_provider.js OTP_FAKE_DIR=/tmp/otp-fake-prefs \
#        ./tools/nested_env.sh tools/inner_prefs_test.sh
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
        const ext = Main.extensionManager.lookup('$UUID').stateObj;
        const row = ext._rows[0];
        return {
            rows: ext._rows.length,
            ids: ext._rows.map(r => r.accountId).join(','),
            subtitleVisible: row && row._subtitle.visible ? 1 : 0,
            codeText: row ? row._codeLabel.text : '',
            countdownVisible: row && row._countdownTrack.visible ? 1 : 0,
            scrollStyle: ext._scrollView.get_style() || '',
            appIcon: ext._appButton.get_child().icon_name,
            panelIcon: ext._panelIcon ? ext._panelIcon.icon_name : '',
            appButtonVisible: ext._appButton.visible ? 1 : 0,
            compact: row && row.get_style_class_name().includes('compact') ? 1 : 0,
            rowHeight: row ? row.get_height() : -1,
            visibleRows: ext._rows.filter(r => r.visible).length,
            menuOpen: ext._button.menu.isOpen ? 1 : 0,
            entryFocused: ext._entry.clutter_text.has_key_focus() ? 1 : 0,
            shortcutAllowed: typeof Main.wm._allowedKeybindings['open-dialog-shortcut'] !== 'undefined' ? 1 : 0,
            appShortcutAllowed: typeof Main.wm._allowedKeybindings['open-app-shortcut'] !== 'undefined' ? 1 : 0
        };
    })()"
}

setbool() {
    jseval "Main.extensionManager.lookup('$UUID').stateObj._settings.set_boolean('$1', $2); 'ok'" >/dev/null
}
setstr() {
    jseval "Main.extensionManager.lookup('$UUID').stateObj._settings.set_string('$1', '$2'); 'ok'" >/dev/null
}
setint() {
    jseval "Main.extensionManager.lookup('$UUID').stateObj._settings.set_int('$1', $2); 'ok'" >/dev/null
}
setstrv() {
    jseval "const s=Main.extensionManager.lookup('$UUID').stateObj._settings; s.set_strv('$1', ['$2']); 'ok'" >/dev/null
}

# Three accounts, deliberately out of name order, so sorting is observable.
mkdir -p "$FAKE"
printf 'fake:3\nfake:1\nfake:2\n' > "$FAKE/ids"
printf '123456' > "$FAKE/code"
rm -f "$FAKE/locked" "$FAKE/delay_ms" "$FAKE/delay_first_ms" "$FAKE/omit_name"

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
    [ "$(echo "$state" | get rows)" = "3" ] 2>/dev/null && break
    sleep 0.5
done

# 1. Defaults from the schema must be the untouched behaviour.
check "three account rows present" "3" "$(echo "$state" | get rows)"
check "default order is the provider order" "fake:3,fake:1,fake:2" "$(echo "$state" | get ids)"
check "default shows the provider name" "1" "$(echo "$state" | get subtitleVisible)"
check "default registers the shortcut" "1" "$(echo "$state" | get shortcutAllowed)"
check "default open-app icon" "go-next-symbolic" "$(echo "$state" | get appIcon)"
check "default panel icon" "dialog-password-symbolic" "$(echo "$state" | get panelIcon)"
check "default row density is comfortable" "0" "$(echo "$state" | get compact)"
check "default registers the open-app shortcut" "1" "$(echo "$state" | get appShortcutAllowed)"

# 2. sort-by = name rebuilds the rows in name order.
setstr "sort-by" "name"
for _ in $(seq 1 20); do
    sorted=$(snap)
    [ "$(echo "$sorted" | get ids)" = "fake:1,fake:2,fake:3" ] && break
    sleep 0.5
done
check "sort-by=name orders rows by name" "fake:1,fake:2,fake:3" "$(echo "$sorted" | get ids)"

# 3. show-provider-name = false hides the subtitle.
setbool "show-provider-name" "false"
for _ in $(seq 1 20); do
    hidden=$(snap)
    [ "$(echo "$hidden" | get subtitleVisible)" = "0" ] && break
    sleep 0.5
done
check "show-provider-name=false hides the subtitle" "0" "$(echo "$hidden" | get subtitleVisible)"

# 3b. row-density = compact marks the rebuilt rows and makes them shorter.
comfortH=$(snap | get rowHeight)
setstr "row-density" "compact"
for _ in $(seq 1 20); do
    dense=$(snap)
    [ "$(echo "$dense" | get compact)" = "1" ] && break
    sleep 0.5
done
check "row-density=compact marks rows compact" "1" "$(echo "$dense" | get compact)"
compactH=$(snap | get rowHeight)
check "compact rows are shorter" "yes" "$([ "$compactH" -gt 0 ] && [ "$compactH" -lt "$comfortH" ] && echo yes || echo no)"
setstr "row-density" "comfortable"

# 3c. search-fields limits which field the search matches. "Provider" only
# appears in the provider description ("Fake Provider"), never in the name.
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._entry.set_text('Provider'); 'ok'" >/dev/null
sleep 0.5
both=$(snap)
check "search matches the provider by default" "3" "$(echo "$both" | get visibleRows)"
setstr "search-fields" "name"
for _ in $(seq 1 20); do
    nameonly=$(snap)
    [ "$(echo "$nameonly" | get visibleRows)" = "0" ] && break
    sleep 0.5
done
check "search-fields=name ignores the provider" "0" "$(echo "$nameonly" | get visibleRows)"
setstr "search-fields" "provider"
for _ in $(seq 1 20); do
    provonly=$(snap)
    [ "$(echo "$provonly" | get visibleRows)" = "3" ] && break
    sleep 0.5
done
check "search-fields=provider matches the provider" "3" "$(echo "$provonly" | get visibleRows)"
setstr "search-fields" "both"
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._entry.set_text(''); 'ok'" >/dev/null
sleep 0.5

# 4. code-grouping groups the revealed digits.
setbool "code-grouping" "true"
sleep 0.5
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._reveal(e._rows[0]); 'ok'" >/dev/null
grouped=""
for _ in $(seq 1 20); do
    grouped=$(snap)
    [ "$(echo "$grouped" | get codeText)" = "123 456" ] && break
    sleep 0.5
done
check "code-grouping groups the revealed code" "123 456" "$(echo "$grouped" | get codeText)"

# 5. show-countdown-bar = false hides the validity bar.
setbool "show-countdown-bar" "false"
sleep 0.5
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._reveal(e._rows[0]); 'ok'" >/dev/null
sleep 1
check "show-countdown-bar=false hides the bar" "0" "$(snap | get countdownVisible)"
setbool "show-countdown-bar" "true"

# 6. popup-rows changes the scroll view height (4 em per row).
setint "popup-rows" "3"
sleep 0.5
check "popup-rows=3 sets a 12em list height" "yes" "$(snap | get scrollStyle | grep -q 'height: 12em' && echo yes || echo no)"

# 7. open-app-icon changes the button icon.
setstr "open-app-icon" "window-new-symbolic"
sleep 0.5
check "open-app-icon updates the button icon" "window-new-symbolic" "$(snap | get appIcon)"

# 7b. panel-icon changes the panel indicator icon.
setstr "panel-icon" "changes-prevent-symbolic"
sleep 0.5
check "panel-icon updates the panel icon" "changes-prevent-symbolic" "$(snap | get panelIcon)"

# 8. show-open-app-button hides and shows the button.
setbool "show-open-app-button" "false"
sleep 0.5
check "show-open-app-button=false hides the button" "0" "$(snap | get appButtonVisible)"
setbool "show-open-app-button" "true"
sleep 0.5
check "show-open-app-button=true shows the button" "1" "$(snap | get appButtonVisible)"

# 9. focus-search-on-open controls the caret.
setbool "focus-search-on-open" "false"
close_menu
sleep 0.5
open_menu
for _ in $(seq 1 20); do
    unfocused=$(snap)
    [ "$(echo "$unfocused" | get rows)" = "3" ] && break
    sleep 0.5
done
sleep 0.5
check "focus-search-on-open=false leaves the search unfocused" "0" "$(snap | get entryFocused)"
setbool "focus-search-on-open" "true"
close_menu
sleep 0.5
open_menu
for _ in $(seq 1 20); do
    focused=$(snap)
    [ "$(echo "$focused" | get entryFocused)" = "1" ] && break
    sleep 0.5
done
check "focus-search-on-open=true focuses the search" "1" "$(echo "$focused" | get entryFocused)"

# 10. close-after-copy closes the popup on activation.
setbool "close-after-copy" "true"
sleep 0.5
ev "const e=Main.extensionManager.lookup('$UUID').stateObj; e._copy(e._rows[0]); 'ok'" >/dev/null
closed=""
for _ in $(seq 1 20); do
    closed=$(snap)
    [ "$(echo "$closed" | get menuOpen)" = "0" ] && break
    sleep 0.5
done
check "close-after-copy=true closes the popup" "0" "$(echo "$closed" | get menuOpen)"
setbool "close-after-copy" "false"

# 11. the shortcut can be re-registered at runtime.
setstrv "open-dialog-shortcut" "<Super><Shift>b"
sleep 0.5
check "shortcut stays registered after a schema change" "1" "$(snap | get shortcutAllowed)"

for line in "${RESULTS[@]}"; do echo "$line"; done
echo "RESULT pass=$PASS fail=$FAIL"
echo "shell errors:"
grep -iE "authenticator-companion|JS ERROR|Gjs-ERROR" "$OTP_RUNTIME/shell.log" 2>/dev/null | head -20
[ "$FAIL" -eq 0 ]

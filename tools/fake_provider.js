// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test harness only (not part of the extension).
//
// Minimal SearchProvider2 implementation with controllable availability and
// latency. It lets the nested-shell tests reproduce lock and delayed-reply
// races deterministically, without touching the real Authenticator instance.
//
// Control files live in OTP_FAKE_DIR (default /tmp/otp-fake):
//   locked          -> GetInitialResultSet returns []
//   delay_ms        -> delay every GetResultMetas reply by this many ms
//   delay_first_ms  -> delay only the next GetResultMetas reply, then consume
//   ids             -> newline-separated result ids (default "fake:1")
//   code            -> clipboardText returned by GetResultMetas
//   omit_name       -> drop the required `name` key (malformed metadata)
//
// Like Authenticator 4.6.2, GetResultMetas ignores the `locked` flag: that
// asymmetry is exactly what the extension has to defend against.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DIR = GLib.getenv('OTP_FAKE_DIR') || '/tmp/otp-fake';
const BUS_NAME = 'com.belmoussaoui.Authenticator.SearchProvider';
const OBJ_PATH = '/com/belmoussaoui/Authenticator/SearchProvider';

const XML = `<node>
  <interface name="org.gnome.Shell.SearchProvider2">
    <method name="GetInitialResultSet">
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetSubsearchResultSet">
      <arg type="as" name="previous_results" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetResultMetas">
      <arg type="as" name="identifiers" direction="in"/>
      <arg type="aa{sv}" name="metas" direction="out"/>
    </method>
    <method name="ActivateResult">
      <arg type="s" name="identifier" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="LaunchSearch">
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
  </interface>
</node>`;

function controlPath(name) {
    return GLib.build_filenamev([DIR, name]);
}

function exists(name) {
    return GLib.file_test(controlPath(name), GLib.FileTest.EXISTS);
}

function readText(name, fallback) {
    try {
        const [ok, bytes] = GLib.file_get_contents(controlPath(name));
        if (!ok)
            return fallback;
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return fallback;
    }
}

function readInt(name, fallback) {
    const value = Number.parseInt(readText(name, ''), 10);
    return Number.isFinite(value) ? value : fallback;
}

/** Read an integer control value and delete the file (one-shot control). */
function consumeInt(name) {
    if (!exists(name))
        return 0;
    const value = readInt(name, 0);
    GLib.unlink(controlPath(name));
    return value;
}

function resultIds() {
    return readText('ids', 'fake:1')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

function resultMetas(requested) {
    const string = GLib.Variant.new_string;
    const code = readText('code', '111111');
    const omitName = exists('omit_name');
    return requested.map(id => {
        const meta = {
            id: string(id),
            description: string('Fake Provider'),
            clipboardText: string(code),
        };
        if (!omitName)
            meta.name = string(`Account ${id}`);
        return meta;
    });
}

const nodeInfo = Gio.DBusNodeInfo.new_for_xml(XML);
const ifaceInfo = nodeInfo.interfaces[0];

Gio.DBus.session.register_object(
    OBJ_PATH, ifaceInfo,
    (conn, sender, path, iface, method, params, invocation) => {
        if (method === 'GetInitialResultSet') {
            const results = exists('locked') ? [] : resultIds();
            invocation.return_value(new GLib.Variant('(as)', [results]));
            return;
        }

        if (method === 'GetResultMetas') {
            const [requested] = params.recursiveUnpack();
            const delay = Math.max(consumeInt('delay_first_ms'), readInt('delay_ms', 0));
            const reply = () => {
                invocation.return_value(
                    new GLib.Variant('(aa{sv})', [resultMetas(requested)]));
                return GLib.SOURCE_REMOVE;
            };
            if (delay > 0)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, reply);
            else
                reply();
            return;
        }

        // ActivateResult / LaunchSearch / GetSubsearchResultSet: no-op replies.
        if (method === 'GetSubsearchResultSet')
            invocation.return_value(new GLib.Variant('(as)', [resultIds()]));
        else
            invocation.return_value(null);
    },
    null, null);

Gio.bus_own_name_on_connection(
    Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);

print('fake provider ready');
GLib.MainLoop.new(null, false).run();

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Minimal host-session check (test harness, not part of the extension).
//
// Uses the exact asynchronous Gio.DBusProxy pattern the extension uses and
// talks to the real Authenticator Flatpak on the real session bus:
// list the accounts, then read their metadata (name/provider/current code).
//
//   gjs -m tools/dbustest.js
//
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusProxy, 'new', 'new_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

const BUS_NAME = 'com.belmoussaoui.Authenticator.SearchProvider';
const OBJECT_PATH = '/com/belmoussaoui/Authenticator/SearchProvider';
const IFACE = 'org.gnome.Shell.SearchProvider2';

const loop = GLib.MainLoop.new(null, false);

async function main() {
    const proxy = await Gio.DBusProxy.new(
        Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
        BUS_NAME, OBJECT_PATH, IFACE, null);
    print(`proxy created; nameOwner=${proxy.g_name_owner}`);

    const idsResult = await proxy.call('GetInitialResultSet',
        new GLib.Variant('(as)', [['']]), Gio.DBusCallFlags.NONE, -1, null);
    const [ids] = idsResult.recursiveUnpack();
    print(`account ids: ${JSON.stringify(ids)}`);

    const metasResult = await proxy.call('GetResultMetas',
        new GLib.Variant('(as)', [ids]), Gio.DBusCallFlags.NONE, -1, null);
    const [metas] = metasResult.recursiveUnpack();
    for (const meta of metas)
        print(`  ${meta.id}: ${meta.name} / ${meta.description} -> ${meta.clipboardText}`);
}

main().then(() => loop.quit()).catch(e => {
    printerr(`ERR: ${e}`);
    loop.quit();
});
loop.run();

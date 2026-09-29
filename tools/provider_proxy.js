// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test harness only (not part of the extension).
//
// Runs on a private D-Bus session bus and re-exports Authenticator's
// org.gnome.Shell.SearchProvider2 service, forwarding every call to the real
// provider on the host session bus. This lets a nested GNOME Shell (which has
// its own session bus and therefore cannot unlock the Flatpak keyring) talk to
// the already-running, unlocked Authenticator instance.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HOST_ADDRESS = GLib.getenv('HOST_DBUS_ADDRESS');
const BUS_NAME = 'com.belmoussaoui.Authenticator.SearchProvider';
const OBJ_PATH = '/com/belmoussaoui/Authenticator/SearchProvider';
const IFACE = 'org.gnome.Shell.SearchProvider2';

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

const hostConn = Gio.DBusConnection.new_for_address_sync(
    HOST_ADDRESS,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
    Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    null, null);

const hostProxy = Gio.DBusProxy.new_sync(
    hostConn, Gio.DBusProxyFlags.NONE, null,
    BUS_NAME, OBJ_PATH, IFACE, null);

const nodeInfo = Gio.DBusNodeInfo.new_for_xml(XML);
const ifaceInfo = nodeInfo.interfaces[0];

Gio.DBus.session.register_object(
    OBJ_PATH, ifaceInfo,
    (conn, sender, path, iface, method, params, invocation) => {
        try {
            const reply = hostProxy.call_sync(
                method, params, Gio.DBusCallFlags.NONE, -1, null);
            invocation.return_value(reply);
        } catch (e) {
            invocation.return_dbus_error(
                'org.gnome.Shell.SearchProvider2.Error', e.message);
        }
    },
    null, null);

Gio.bus_own_name_on_connection(
    Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);

print('provider proxy ready');
GLib.MainLoop.new(null, false).run();

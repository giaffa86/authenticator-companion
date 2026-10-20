// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Shell already promisifies DBusProxy.new, but not DBusProxy.call.
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

const BUS_NAME = 'com.belmoussaoui.Authenticator.SearchProvider';
const OBJECT_PATH = '/com/belmoussaoui/Authenticator/SearchProvider';
const IFACE = 'org.gnome.Shell.SearchProvider2';

export class AuthenticatorSearchProvider {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy = null;
    }

    async _ensureProxy() {
        if (this._proxy)
            return this._proxy;

        const proxy = await Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.NONE,
            null,
            BUS_NAME,
            OBJECT_PATH,
            IFACE,
            this._cancellable);
        this._proxy = proxy;
        return proxy;
    }

    async _call(method, argsVariant) {
        const proxy = await this._ensureProxy();
        return proxy.call(
            method,
            argsVariant,
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable);
    }

    // Returns [] when Authenticator is locked or has no accounts.
    async listAccountIds() {
        const result = await this._call(
            'GetInitialResultSet',
            new GLib.Variant('(as)', [['']]));
        const [ids] = result.recursiveUnpack();
        return ids;
    }

    /**
     * The Search Provider only exposes account names together with the current
     * TOTP code, so this necessarily transfers codes. They are returned to the
     * caller and never stored by this class.
     * @returns {Promise<Array<{id: string, name: string, description: string, code: ?string}>>}
     */
    async getResultMetas(ids) {
        const result = await this._call(
            'GetResultMetas',
            new GLib.Variant('(as)', [ids]));
        const [metas] = result.recursiveUnpack();
        return metas.map(meta => ({
            id: meta.id,
            name: meta.name,
            description: meta.description ?? '',
            code: meta.clipboardText ?? null,
        }));
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// OTP Panel — GNOME Shell 50 extension.
//
// Shows the accounts configured in GNOME Authenticator (com.belmoussaoui.Authenticator)
// in the top panel and copies the current one-time password with a click.
//
// Design constraints (see README.md):
//   * Authenticator is the only source of truth. Accounts and codes are read
//     exclusively through its org.gnome.Shell.SearchProvider2 D-Bus service.
//   * No secret is ever imported, derived or read from the keyring.
//   * No global D-Bus filter is installed (Gio.DBus.session.add_filter() must not
//     be used: it crashes GNOME Shell 50 devkit sessions).
//   * Codes are never written to GSettings, files, logs or notifications, and are
//     kept in memory only while the popup is open and only for revealed rows.

'use strict';

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.DBusProxy, 'new', 'new_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

const APP_ID = 'com.belmoussaoui.Authenticator';
const DESKTOP_FILE = `${APP_ID}.desktop`;
const BUS_NAME = `${APP_ID}.SearchProvider`;
const OBJECT_PATH = '/com/belmoussaoui/Authenticator/SearchProvider';
const IFACE = 'org.gnome.Shell.SearchProvider2';

// How often the open popup re-checks availability and refreshes revealed codes.
// This keeps the displayed code in sync with its expiry without any long-lived
// caching. The timer only runs while the menu is open.
const REFRESH_INTERVAL_MS = 1000;

// Fallback TOTP period, used only to draw the countdown before the real period
// has been observed. The actual value is measured from code changes.
const DEFAULT_PERIOD_SECONDS = 30;
const MIN_PERIOD_SECONDS = 5;
const MAX_PERIOD_SECONDS = 300;

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

function isCancelled(error) {
    return !!error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Thin asynchronous client for Authenticator's Search Provider.
 *
 * Only two read-only methods are used:
 *   - GetInitialResultSet([''])  -> list of "providerId:accountId" identifiers
 *   - GetResultMetas([id, ...])  -> account name/provider and the current code
 *
 * The app is D-Bus activatable, so a call also starts it when it is not running.
 */
class AuthenticatorSearchProvider {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
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

    /** @returns {Promise<string[]>} all account identifiers, [] when none/locked */
    async listAccountIds() {
        const result = await this._call(
            'GetInitialResultSet',
            new GLib.Variant('(as)', [['']]));
        const [ids] = result.recursiveUnpack();
        return Array.isArray(ids) ? ids : [];
    }

    /**
     * The Search Provider only exposes account names together with the current
     * TOTP code, so this necessarily transfers codes. They are returned to the
     * caller and never stored by this class.
     * @returns {Promise<Array<{id: string, name: string, description: string, code: ?string}>>}
     */
    async getResultMetas(ids) {
        if (ids.length === 0)
            return [];

        const result = await this._call(
            'GetResultMetas',
            new GLib.Variant('(as)', [ids]));
        const [metas] = result.recursiveUnpack();
        return (metas ?? []).map(meta => ({
            id: meta.id,
            name: meta.name ?? '',
            description: meta.description ?? '',
            code: meta.clipboardText ?? null,
        }));
    }
}

/**
 * One account row: name + provider, a masked code and a reveal button.
 * Activating the row copies the current code (fetched fresh by the caller).
 */
const AccountMenuItem = GObject.registerClass(
class AccountMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(meta, {onReveal, onCopy}) {
        super._init({style_class: 'otp-panel-item'});

        this.accountId = meta.id;
        this.accountName = meta.name;
        this.providerName = meta.description;

        this._onReveal = onReveal;
        this._onCopy = onCopy;

        this._code = null;
        this._revealed = false;
        this._period = DEFAULT_PERIOD_SECONDS;
        this._lastChangeMs = 0;
        this._expiryMs = 0;
        this._copied = false;
        this._copyResetId = 0;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._title = new St.Label({
            text: meta.name,
            style_class: 'otp-panel-title',
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._subtitle = new St.Label({
            text: meta.description,
            style_class: 'otp-panel-subtitle',
        });
        this._subtitle.clutter_text.ellipsize = 1;
        this._codeLabel = new St.Label({
            text: MASK,
            style_class: 'otp-panel-code',
        });
        box.add_child(this._title);
        box.add_child(this._subtitle);
        box.add_child(this._codeLabel);
        this.add_child(box);

        this._revealButton = new St.Button({
            style_class: 'otp-panel-reveal button',
            can_focus: true,
            accessible_name: _('Show code'),
        });
        this._revealIcon = new St.Icon({
            icon_name: 'view-reveal-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._revealButton.set_child(this._revealIcon);
        this._revealButton.connect('clicked', () => this._onReveal(this));
        this.add_child(this._revealButton);

        this.connect('activate', () => this._onCopy(this));
    }

    get revealed() {
        return this._revealed;
    }

    /** Case-insensitive match on account and provider name. */
    matches(term) {
        if (!term)
            return true;
        const needle = term.toLowerCase();
        return this.accountName.toLowerCase().includes(needle) ||
            this.providerName.toLowerCase().includes(needle);
    }

    setRevealed(revealed) {
        this._revealed = revealed;
        this._revealIcon.icon_name = revealed
            ? 'view-conceal-symbolic'
            : 'view-reveal-symbolic';
        this._renderCode();
    }

    /** Update the cached code and detect the account's TOTP period. */
    setCode(code) {
        const nowMs = GLib.get_real_time() / 1000;
        if (this._code !== null && code !== this._code && this._lastChangeMs > 0) {
            const measured = Math.round((nowMs - this._lastChangeMs) / 1000);
            if (measured >= MIN_PERIOD_SECONDS && measured <= MAX_PERIOD_SECONDS)
                this._period = measured;
        }
        if (code !== this._code)
            this._lastChangeMs = nowMs;
        this._code = code;
        this._expiryMs = this._periodEndMs(nowMs);
        this._renderCode();
    }

    /** Drop the code from memory and mask the row again. */
    clearCode() {
        this._code = null;
        this._revealed = false;
        this._expiryMs = 0;
        this._revealIcon.icon_name = 'view-reveal-symbolic';
        this._codeLabel.text = MASK;
        this._codeLabel.remove_style_class_name('otp-panel-code-visible');
    }

    _periodEndMs(nowMs) {
        const period = this._period;
        const nowSeconds = Math.floor(nowMs / 1000);
        const nextBoundary = (Math.floor(nowSeconds / period) + 1) * period;
        return nextBoundary * 1000;
    }

    /** Seconds left before the displayed code is expected to change. */
    remainingSeconds() {
        if (this._expiryMs === 0)
            return 0;
        const left = Math.ceil((this._expiryMs - GLib.get_real_time() / 1000) / 1000);
        return Math.max(0, left);
    }

    _renderCode() {
        if (this._copied) {
            this._codeLabel.text = _('Copied to clipboard');
            this._codeLabel.add_style_class_name('otp-panel-code-visible');
            return;
        }
        if (this._revealed && this._code !== null) {
            this._codeLabel.text = `${this._code}  \u00b7  ${this.remainingSeconds()}s`;
            this._codeLabel.add_style_class_name('otp-panel-code-visible');
        } else {
            this._codeLabel.text = MASK;
            this._codeLabel.remove_style_class_name('otp-panel-code-visible');
        }
    }

    /** Refresh the countdown label on each tick (no D-Bus call needed). */
    tick() {
        if (this._revealed && !this._copied && this._code !== null)
            this._renderCode();
    }

    flashCopied() {
        this._copied = true;
        this._renderCode();
        if (this._copyResetId)
            GLib.source_remove(this._copyResetId);
        this._copyResetId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1500,
            () => {
                this._copyResetId = 0;
                this._copied = false;
                this._renderCode();
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
        if (this._copyResetId) {
            GLib.source_remove(this._copyResetId);
            this._copyResetId = 0;
        }
        this._code = null;
        super.destroy();
    }
});

export default class OtpPanelExtension extends Extension {
    enable() {
        this._service = new AuthenticatorSearchProvider();
        this._rows = [];
        this._refreshId = 0;
        this._busy = false;
        this._lastIds = [];
        this._lastErrorText = null;
        this._tickCounter = 0;

        this._button = new PanelMenu.Button(0.5, _('OTP Panel'), false);
        this._button.add_child(new St.Icon({
            icon_name: 'dialog-password-symbolic',
            style_class: 'system-status-icon',
        }));

        const menu = this._button.menu;

        // Search entry (client-side filter by account/provider name).
        const searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'otp-panel-search-item',
        });
        this._entry = new St.Entry({
            hint_text: _('Search accounts\u2026'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'popup-menu-icon',
        }));
        searchItem.add_child(this._entry);
        menu.addMenuItem(searchItem);

        this._entryTextChangedId =
            this._entry.clutter_text.connect('text-changed', () => this._filter());

        // Status placeholder (loading / locked / unavailable).
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.add_style_class_name('otp-panel-status');
        menu.addMenuItem(this._statusItem);

        // Scrollable account list. PopupMenuSection has no scroll view of its
        // own, so the section actor is wrapped once and inserted into the menu.
        this._section = new PopupMenu.PopupMenuSection();
        this._scrollView = new St.ScrollView({
            style_class: 'otp-panel-scrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._scrollView.set_child(this._section.actor);
        menu.box.add_child(this._scrollView);

        // "Open Authenticator" action, shown with the status.
        this._openItem = new PopupMenu.PopupMenuItem(_('Open Authenticator'));
        this._openItem.connect('activate', () => this._openAuthenticator());
        menu.addMenuItem(this._openItem);

        this._menuOpenId = menu.connect('open-state-changed',
            (_menu, open) => open ? this._onMenuOpen() : this._onMenuClose());

        Main.panel.addToStatusArea(this.uuid, this._button);
    }

    disable() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }

        if (this._entryTextChangedId) {
            this._entry?.clutter_text.disconnect(this._entryTextChangedId);
            this._entryTextChangedId = 0;
        }

        if (this._menuOpenId) {
            this._button?.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }

        this._clearRows();

        if (this._entry) {
            this._entry.destroy();
            this._entry = null;
        }

        if (this._section) {
            this._section.destroy();
            this._section = null;
        }

        if (this._scrollView) {
            this._scrollView.destroy();
            this._scrollView = null;
        }

        if (this._statusItem) {
            this._statusItem.destroy();
            this._statusItem = null;
        }

        if (this._openItem) {
            this._openItem.destroy();
            this._openItem = null;
        }

        this._button?.destroy();
        this._button = null;

        this._service?.destroy();
        this._service = null;
    }

    // --- menu lifecycle -----------------------------------------------------

    _onMenuOpen() {
        this._tickCounter = 0;
        this._lastErrorText = null;
        this._setStatus(_('Loading\u2026'), {open: false});
        this._refresh().catch(e => this._reportError(e));
        if (!this._refreshId) {
            this._refreshId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                REFRESH_INTERVAL_MS,
                () => {
                    this._tick().catch(e => this._reportError(e));
                    return GLib.SOURCE_CONTINUE;
                });
        }
    }

    _onMenuClose() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._entry?.set_text('');
        // Never keep codes around once the popup is closed.
        for (const row of this._rows)
            row.clearCode();
        this._clearRows();
        this._lastIds = [];
    }

    // --- data flow ----------------------------------------------------------

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const ids = await this._service.listAccountIds();
            if (ids.length === 0) {
                this._clearRows();
                this._lastIds = [];
                this._setStatus(
                    _('No codes available. Authenticator is locked or has no accounts.'),
                    {open: true});
                return;
            }

            if (!this._sameIds(ids)) {
                const metas = await this._service.getResultMetas(ids);
                this._rebuildRows(metas);
                this._lastIds = ids;
            }
            this._setStatus(null, {open: false});
            this._lastErrorText = null;
        } finally {
            this._busy = false;
        }
    }

    async _tick() {
        if (this._busy || !this._button?.menu.isOpen)
            return;

        // While the provider is unreachable, retry about every 5 s instead of
        // hammering the bus and the log once per second.
        this._tickCounter++;
        if (this._lastErrorText !== null && this._tickCounter % 5 !== 0)
            return;

        this._busy = true;
        try {
            // Availability gate: the provider returns an empty set while the app
            // is locked, so this also honours a lock happening with the popup
            // already open. GetResultMetas is only ever called for ids returned
            // by the current gate.
            const ids = await this._service.listAccountIds();
            if (ids.length === 0) {
                this._clearRows();
                this._lastIds = [];
                this._setStatus(
                    _('No codes available. Authenticator is locked or has no accounts.'),
                    {open: true});
                return;
            }
            this._lastErrorText = null;

            for (const row of this._rows)
                row.tick();

            const revealedIds = this._rows
                .filter(row => row.revealed)
                .map(row => row.accountId);

            if (revealedIds.length > 0) {
                const metas = await this._service.getResultMetas(revealedIds);
                const byId = new Map(metas.map(m => [m.id, m]));
                for (const row of this._rows) {
                    const meta = byId.get(row.accountId);
                    if (meta && row.revealed)
                        row.setCode(meta.code);
                }
            }
        } finally {
            this._busy = false;
        }
    }

    _sameIds(ids) {
        return ids.length === this._lastIds.length &&
            ids.every((id, i) => id === this._lastIds[i]);
    }

    _rebuildRows(metas) {
        this._clearRows();
        for (const meta of metas) {
            const row = new AccountMenuItem(meta, {
                onReveal: r => this._reveal(r),
                onCopy: r => this._copy(r),
            });
            this._rows.push(row);
            this._section.addMenuItem(row);
        }
        this._filter();
    }

    _clearRows() {
        for (const row of this._rows)
            row.destroy();
        this._rows = [];
    }

    _filter() {
        const term = this._entry?.get_text().trim() ?? '';
        for (const row of this._rows)
            row.visible = row.matches(term);
    }

    // --- actions ------------------------------------------------------------

    async _reveal(row) {
        if (row.revealed) {
            row.setRevealed(false);
            row.clearCode();
            return;
        }

        try {
            const [meta] = await this._service.getResultMetas([row.accountId]);
            if (!meta) {
                row.clearCode();
                return;
            }
            row.setRevealed(true);
            row.setCode(meta.code);
        } catch (e) {
            if (!isCancelled(e))
                this._reportError(e);
        }
    }

    async _copy(row) {
        try {
            // Always fetch a fresh code right before copying.
            const [meta] = await this._service.getResultMetas([row.accountId]);
            if (!meta?.code) {
                this._setStatus(
                    _('No codes available. Authenticator is locked or has no accounts.'),
                    {open: true});
                return;
            }
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, meta.code);
            row.flashCopied();
            // The code is intentionally dropped as soon as it is copied and the
            // row goes back to masked; only the short-lived "Copied"
            // confirmation stays on screen.
            row.setRevealed(false);
            row._code = null;
        } catch (e) {
            if (!isCancelled(e))
                this._reportError(e);
        }
    }

    _openAuthenticator() {
        const app = GioUnix.DesktopAppInfo.new(DESKTOP_FILE);
        if (!app) {
            this._setStatus(_('Authenticator is not installed.'), {open: false});
            return;
        }
        this._button?.menu.close();
        app.launch([], null);
    }

    // --- status -------------------------------------------------------------

    _setStatus(text, {open}) {
        this._statusItem.visible = text !== null;
        if (text !== null)
            this._statusItem.label.text = text;
        this._openItem.visible = !!open;
    }

    _reportError(error) {
        if (isCancelled(error))
            return;
        this._clearRows();
        this._lastIds = [];

        // Tell "not installed" apart from "installed but unreachable" so the
        // message is accurate and the open-app entry is only shown when there
        // is actually something to open.
        const installed = !!GioUnix.DesktopAppInfo.new(DESKTOP_FILE);
        const text = installed
            ? _('Authenticator is not available. Make sure it is running.')
            : _('Authenticator is not installed.');

        // Log once per state change, never once per retry.
        if (text !== this._lastErrorText) {
            console.error(`[otp-panel] ${error}`);
            this._lastErrorText = text;
        }
        this._setStatus(text, {open: installed});
    }
}

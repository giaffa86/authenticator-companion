// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AccountMenuItem} from './accountMenuItem.js';
import {AuthenticatorSearchProvider} from './provider.js';

const DESKTOP_FILE = 'com.belmoussaoui.Authenticator.desktop';
const REFRESH_INTERVAL_MS = 1000;
const ACTION_STATUS_MS = 4000;

export class AuthenticatorPopup {
    constructor(settings, uuid) {
        this._generation = 0;
        this._settings = settings;
        this._uuid = uuid;
        this._service = new AuthenticatorSearchProvider();
        this._rows = [];
        this._refreshId = 0;
        this._focusId = 0;
        this._refreshRequest = null;
        this._lastIds = [];
        this._lastErrorText = null;
        this._statusText = null;
        this._tickCounter = 0;
        this._statusHoldUntil = 0;

        this._button = new PanelMenu.Button(0.5, _('Authenticator Companion'), false);
        this._panelIcon = new St.Icon({
            icon_name: this._settings.get_string('panel-icon'),
            style_class: 'system-status-icon',
        });
        this._button.add_child(this._panelIcon);

        const menu = this._button.menu;

        const searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'authenticator-companion-search-item',
        });
        const searchRow = new St.BoxLayout({
            style_class: 'authenticator-companion-search-row',
            reactive: true,
            x_expand: true,
        });
        this._entry = new St.Entry({
            hint_text: _('Search accounts\u2026'),
            style_class: 'authenticator-companion-search-entry',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'popup-menu-icon',
        }));
        searchRow.add_child(this._entry);

        this._appButton = new St.Button({
            style_class: 'authenticator-companion-open-app',
            can_focus: true,
            accessible_name: _('Open Authenticator'),
        });
        this._appButton.set_child(new St.Icon({
            icon_name: this._settings.get_string('open-app-icon'),
            style_class: 'popup-menu-icon',
        }));
        this._appButton.connect('clicked', () => {
            this._button.menu.close();
            this._openAuthenticator();
        });
        this._appButton.visible = false;
        searchRow.add_child(this._appButton);
        searchItem.add_child(searchRow);

        menu.addMenuItem(searchItem);

        this._entryTextChangedId =
            this._entry.clutter_text.connect('text-changed', () => this._filter());
        this._entryFocusInId = this._entry.clutter_text.connect('key-focus-in', () =>
            searchRow.add_style_class_name('focused'));
        this._entryFocusOutId = this._entry.clutter_text.connect('key-focus-out', () =>
            searchRow.remove_style_class_name('focused'));

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.add_style_class_name('authenticator-companion-status');
        menu.addMenuItem(this._statusItem);

        // Scrollable account list. PopupMenuSection has no scroll view of its
        // own, so the section actor is wrapped once and inserted into the menu.
        this._section = new PopupMenu.PopupMenuSection();
        this._section.actor.add_style_class_name('authenticator-companion-list');
        this._scrollView = new St.ScrollView({
            style_class: 'authenticator-companion-scrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._scrollView.set_child(this._section.actor);
        // Inserted directly instead of through addMenuItem(): a row copies on
        // activation without closing the popup, so the "Copied" confirmation
        // stays visible.
        menu.box.add_child(this._scrollView);

        this._openItem = new PopupMenu.PopupMenuItem(_('Open Authenticator'));
        this._openItem.connect('activate', () => this._openAuthenticator());
        menu.addMenuItem(this._openItem);

        this._menuOpenId = menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._onMenuOpen();
            else
                this._onMenuClose();
        });

        Main.panel.addToStatusArea(this._uuid, this._button);
        this._addKeybindings();
        this._connectSettings();
        this._applyVisualSettings();
    }

    destroy() {
        // A new generation makes every in-flight continuation return at its
        // next await, before the D-Bus calls are cancelled.
        this._generation++;
        this._removeKeybindings();
        this._settings.disconnectObject(this);
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        if (this._focusId) {
            GLib.source_remove(this._focusId);
            this._focusId = 0;
        }

        this._entry.clutter_text.disconnect(this._entryTextChangedId);
        this._entry.clutter_text.disconnect(this._entryFocusInId);
        this._entry.clutter_text.disconnect(this._entryFocusOutId);
        this._button.menu.disconnect(this._menuOpenId);

        this._clearRows();
        this._lastIds = [];
        this._refreshRequest = null;
        this._entry.destroy();
        this._entry = null;
        this._appButton.destroy();
        this._appButton = null;
        this._section.destroy();
        this._section = null;
        this._scrollView.destroy();
        this._scrollView = null;
        this._statusItem.destroy();
        this._statusItem = null;
        this._openItem.destroy();
        this._openItem = null;
        this._panelIcon.destroy();
        this._panelIcon = null;
        this._button.destroy();
        this._button = null;
        this._service.destroy();
        this._service = null;
        this._settings = null;
    }

    _addKeybindings() {
        Main.wm.addKeybinding(
            'open-dialog-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            () => this._button.menu.toggle());
        Main.wm.addKeybinding(
            'open-app-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            () => this._openAuthenticator());
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding('open-dialog-shortcut');
        Main.wm.removeKeybinding('open-app-shortcut');
    }

    _connectSettings() {
        // The shortcuts are registered once in enable(); mutter follows each
        // key's GSettings entry on its own, so a changed:: handler must not
        // re-add them.
        const liveKeys = ['popup-rows', 'show-open-app-button', 'open-app-icon', 'panel-icon'];
        for (const key of liveKeys) {
            this._settings.connectObject(`changed::${key}`, () =>
                this._applyVisualSettings(), this);
        }

        const rowKeys = [
            'sort-by', 'show-provider-name', 'code-grouping',
            'show-countdown-bar', 'row-density', 'search-fields',
        ];
        for (const key of rowKeys) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._applyVisualSettings();
                // Rows bake in the appearance, so rebuild them from the provider.
                if (this._button.menu.isOpen && this._rows.length > 0) {
                    this._lastIds = [];
                    this._refresh();
                }
            }, this);
        }
    }

    _applyVisualSettings() {
        this._panelIcon.icon_name = this._settings.get_string('panel-icon');
        this._appButton.get_child().icon_name = this._settings.get_string('open-app-icon');
        // One collapsed row is about 4 em tall. The list is a fixed box,
        // not a max-height: filtering would otherwise shrink the popup on
        // every keystroke. The width is fixed in CSS and the menu follows it.
        this._scrollView.set_style(
            `height: ${this._settings.get_int('popup-rows') * 4}em;`);
        this._syncAppButtonVisibility();
    }

    _syncAppButtonVisibility() {
        this._appButton.visible = this._statusText === null &&
            this._settings.get_boolean('show-open-app-button');
    }

    _sortedMetas(metas) {
        const mode = this._settings.get_string('sort-by');
        if (mode === 'default')
            return metas;
        const key = mode === 'provider' ? 'description' : 'name';
        return [...metas].sort((a, b) =>
            a[key].toLowerCase().localeCompare(b[key].toLowerCase()));
    }

    _formatCode(code) {
        return this._settings.get_boolean('code-grouping')
            ? code.replace(/(.{3})(?=.)/g, '$1 ')
            : code;
    }

    _onMenuOpen() {
        this._tickCounter = 0;
        this._lastErrorText = null;
        this._statusHoldUntil = 0;
        this._refreshRequest = null;
        // A previous session's continuation may still be running; the new
        // session must not be blocked by it. The generation checks discard any
        // stale continuation that loses the race.
        this._setStatus(_('Loading\u2026'), false);
        // Put the caret in the search field as soon as the popup opens, so the
        // user can type without reaching for the pointer. The menu manager has
        // already taken its modal grab by the time this handler runs, but the
        // entry is not mapped yet, so the grab is deferred to the next idle.
        if (this._focusId) {
            GLib.source_remove(this._focusId);
            this._focusId = 0;
        }
        if (this._settings.get_boolean('focus-search-on-open')) {
            this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._focusId = 0;
                if (this._entry && this._button.menu.isOpen)
                    this._entry.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._refresh();
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_MS,
            () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _onMenuClose() {
        if (this._focusId) {
            GLib.source_remove(this._focusId);
            this._focusId = 0;
        }
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        // Close invalidates pending refreshes and row actions alike.
        this._generation++;
        this._statusHoldUntil = 0;
        this._entry.set_text('');
        this._clearRows();
        this._lastIds = [];
    }

    async _refresh() {
        if (this._refreshRequest)
            return;
        const generation = this._generation;
        const request = {};
        this._refreshRequest = request;
        try {
            await this._syncAccounts(generation);
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            if (generation !== this._generation)
                return;
            this._reportError(e);
        } finally {
            if (this._refreshRequest === request)
                this._refreshRequest = null;
        }
    }

    async _tick() {
        if (this._refreshRequest)
            return;

        // While the provider is unreachable, retry about every 5 s instead of
        // hammering the bus and the log once per second.
        this._tickCounter++;
        if (this._lastErrorText !== null && this._tickCounter % 5 !== 0)
            return;

        const generation = this._generation;
        const request = {};
        this._refreshRequest = request;
        try {
            if (!await this._syncAccounts(generation))
                return;

            const revealedIds = this._rows
                .filter(row => row.revealed)
                .map(row => row.accountId);

            if (revealedIds.length > 0) {
                const metas = await this._service.getResultMetas(revealedIds);
                if (generation !== this._generation)
                    return;

                // GetResultMetas ignores the lock state, so confirm the ids are
                // still available after the codes were fetched, and drop them
                // if Authenticator locked in the meantime.
                const available = new Set(await this._service.listAccountIds());
                if (generation !== this._generation)
                    return;

                const byId = new Map(metas.map(m => [m.id, m]));
                for (const row of this._rows) {
                    if (!available.has(row.accountId)) {
                        row.clearCode();
                        continue;
                    }
                    const meta = byId.get(row.accountId);
                    if (meta && row.revealed)
                        row.setCode(meta.code);
                }
            }

            // A copied row is neither revealed nor holds a code, so the fetch
            // above skips it: only this periodic update advances the expiry bar
            // under its "Copied to clipboard" confirmation.
            for (const row of this._rows) {
                if (row.copied)
                    row.updateCountdown();
            }
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            if (generation !== this._generation)
                return;
            this._reportError(e);
        } finally {
            if (this._refreshRequest === request)
                this._refreshRequest = null;
        }
    }

    /**
     * Availability gate and account rebuild, shared by the initial refresh and
     * the periodic tick. GetInitialResultSet is authoritative: it returns an
     * empty set while Authenticator is locked, so this also honours a lock
     * happening with the popup already open, and GetResultMetas is only ever
     * called for ids this gate returned.
     * @returns {Promise<boolean>} whether accounts are currently available.
     */
    async _syncAccounts(generation) {
        const ids = await this._service.listAccountIds();
        if (generation !== this._generation)
            return false;

        if (ids.length === 0) {
            // The provider answered, so the app is reachable: a previous error
            // must not keep the retry throttle on while it is merely locked.
            this._lastErrorText = null;
            this._generation++;
            this._clearRows();
            this._lastIds = [];
            this._setStatus(
                _('No codes available. Authenticator is locked or has no accounts.'),
                true);
            return false;
        }

        // The account set changed while the popup was open (lock/unlock,
        // account added or removed): rebuild so the list and the open-app
        // shortcut stay in sync with the current availability.
        if (!this._sameIds(ids)) {
            const metas = await this._service.getResultMetas(ids);
            if (generation !== this._generation)
                return false;
            this._lastIds = ids;
            // Rebuilding destroys the rows, so invalidate their actions first.
            this._generation++;
            try {
                this._rebuildRows(metas);
            } catch (e) {
                // A provider contract violation (for example a row without the
                // required `name`) must not leave an empty, unrecoverable
                // popup: log it once, show a message and drop the cached ids so
                // a later retry recovers when the provider is fixed again.
                this._reportError(e, _('Unexpected response from Authenticator.'));
                return false;
            }
        }
        // A usable account set answered: clear any error state, but keep a
        // recent reveal/copy message on screen long enough to be read.
        this._lastErrorText = null;
        if (Date.now() >= this._statusHoldUntil)
            this._setStatus(null, false);
        return true;
    }

    _sameIds(ids) {
        return ids.length === this._lastIds.length &&
            ids.every((id, i) => id === this._lastIds[i]);
    }

    _rebuildRows(metas) {
        this._clearRows();
        for (const meta of this._sortedMetas(metas)) {
            const row = new AccountMenuItem(meta, {
                onReveal: r => this._reveal(r),
                onCopy: r => this._copy(r),
                formatCode: code => this._formatCode(code),
                showProviderName: this._settings.get_boolean('show-provider-name'),
                showCountdown: this._settings.get_boolean('show-countdown-bar'),
                rowDensity: this._settings.get_string('row-density'),
                searchFields: this._settings.get_string('search-fields'),
                refreshInterval: REFRESH_INTERVAL_MS,
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
        const term = this._entry.get_text().trim();
        for (const row of this._rows)
            row.visible = row.matches(term);
    }

    /**
     * Fetch one account's metadata behind the authoritative availability gate.
     * The row id came from an earlier gate result, so re-check it now, and
     * re-check once more after fetching the code: GetResultMetas does not
     * enforce the lock itself, so a lock that happens while the request is in
     * flight must not produce a displayed or copied code.
     * @returns {Promise<?object>} metadata, or null when unavailable/stale.
     */
    async _fetchFreshMeta(accountId, generation) {
        const ids = await this._service.listAccountIds();
        if (generation !== this._generation || !ids.includes(accountId))
            return null;

        const [meta] = await this._service.getResultMetas([accountId]);
        if (generation !== this._generation || !meta || meta.id !== accountId)
            return null;

        const stillAvailable = await this._service.listAccountIds();
        if (generation !== this._generation || !stillAvailable.includes(accountId))
            return null;
        return meta;
    }

    async _reveal(row) {
        if (row.revealed) {
            row.clearCode();
            return;
        }

        const generation = this._generation;
        const token = row.beginAction();
        try {
            const meta = await this._fetchFreshMeta(row.accountId, generation);
            if (generation !== this._generation || !row.isCurrentAction(token))
                return;
            if (!meta) {
                row.clearCode();
                return;
            }
            if (!meta.code) {
                row.clearCode();
                this._showActionStatus(
                    _('No code available for this account.'), false);
                return;
            }
            row.clearCopied();
            row.setRevealed(true);
            row.setCode(meta.code);
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            if (generation !== this._generation)
                return;
            this._actionError();
        }
    }

    async _copy(row) {
        const generation = this._generation;
        const token = row.beginAction();
        try {
            const meta = await this._fetchFreshMeta(row.accountId, generation);
            if (generation !== this._generation || !row.isCurrentAction(token))
                return;
            if (!meta || !meta.code) {
                this._showActionStatus(
                    _('No code available for this account.'), false);
                return;
            }
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, meta.code);
            row.flashCopied();
            row.setRevealed(false);
            row.forgetCode();
            if (this._settings.get_boolean('close-after-copy'))
                this._button.menu.close();
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            if (generation !== this._generation)
                return;
            this._actionError();
        }
    }

    _lookupApp() {
        return Shell.AppSystem.get_default().lookup_app(DESKTOP_FILE);
    }

    _isInstalled() {
        return this._lookupApp() !== null;
    }

    _openAuthenticator() {
        const app = this._lookupApp();
        if (app)
            app.activate();
    }

    /**
     * Show a reveal/copy result without letting the next periodic refresh wipe
     * it within the same second.
     */
    _showActionStatus(text, showOpen) {
        this._statusHoldUntil = Date.now() + ACTION_STATUS_MS;
        this._setStatus(text, showOpen);
    }

    _setStatus(text, showOpen) {
        this._statusText = text;
        this._statusItem.visible = text !== null;
        if (text !== null)
            this._statusItem.label.text = text;
        this._openItem.visible = showOpen;
        // The open-app shortcut is only relevant when accounts are available,
        // which is exactly the state in which no status message is shown.
        this._syncAppButtonVisibility();
    }

    _unavailableText(installed) {
        return installed
            ? _('Authenticator is not available. Make sure it is running.')
            : _('Authenticator is not installed.');
    }

    _actionError() {
        const installed = this._isInstalled();
        this._showActionStatus(this._unavailableText(installed), installed);
    }

    _reportError(error, message = null) {
        this._generation++;
        this._clearRows();
        this._lastIds = [];

        // Tell "not installed" apart from "installed but unreachable" so the
        // message is accurate and the open-app entry is only shown when there
        // is actually something to open. A caller-supplied message (provider
        // contract violation) replaces both.
        const installed = message === null && this._isInstalled();
        const text = message ?? this._unavailableText(installed);

        // Log once per state change, never once per retry.
        if (text !== this._lastErrorText) {
            console.error(`[authenticator-companion] ${error}`);
            this._lastErrorText = text;
        }
        this._setStatus(text, installed);
    }
}

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const OPEN_APP_ICONS = [
    'go-next-symbolic',
    'window-new-symbolic',
    'external-link-symbolic',
    'application-x-executable-symbolic',
];

const PANEL_ICONS = [
    'dialog-password-symbolic',
    'channel-secure-symbolic',
    'changes-prevent-symbolic',
    'auth-smartcard-symbolic',
];

function connectSetting(window, settings, signal, callback) {
    window._settingsHandlers.push(settings.connect(signal, callback));
}

function addResetButton(window, row, settings, ...keys) {
    const button = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Reset to default'),
    });

    const updateSensitive = () => {
        button.sensitive = keys.some(key => settings.get_user_value(key) !== null);
    };

    button.connect('clicked', () => {
        for (const key of keys)
            settings.reset(key);
        updateSensitive();
    });

    for (const key of keys)
        connectSetting(window, settings, `changed::${key}`, updateSensitive);

    row.add_suffix(button);
    updateSensitive();
}

function createComboRow(window, settings, key, title, values, labels = values) {
    const row = new Adw.ComboRow({title, model: new Gtk.StringList({strings: labels})});

    const syncFromSettings = () => {
        const index = values.indexOf(settings.get_string(key));
        row.set_selected(index >= 0 ? index : 0);
    };

    syncFromSettings();
    row.connect('notify::selected-item', () => {
        const selected = row.get_selected();
        if (selected >= 0 && selected < values.length)
            settings.set_string(key, values[selected]);
    });
    connectSetting(window, settings, `changed::${key}`, syncFromSettings);

    addResetButton(window, row, settings, key);
    return row;
}

function createSwitchRow(window, settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});

    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    addResetButton(window, row, settings, key);
    return row;
}

function createShortcutRow(window, settings, key, title) {
    const row = new Adw.EntryRow({title, show_apply_button: true});

    const syncFromSettings = () => {
        row.text = settings.get_strv(key)[0] || '';
    };

    syncFromSettings();

    // The apply button (and Enter) commits the accelerator; notify::text fires
    // on every keystroke and would persist partial, invalid values.
    row.connect('apply', () => {
        const text = row.text.trim();
        if (text && !Gtk.accelerator_parse(text)[0]) {
            row.add_css_class('error');
            return;
        }
        row.remove_css_class('error');
        settings.set_strv(key, text ? [text] : []);
    });
    connectSetting(window, settings, `changed::${key}`, syncFromSettings);

    addResetButton(window, row, settings, key);
    return row;
}

export default class AuthenticatorCompanionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settingsHandlers = [];
        window.connect('close-request', () => {
            for (const id of window._settingsHandlers)
                settings.disconnect(id);
            window._settingsHandlers = [];
            return false;
        });

        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const behaviourGroup = new Adw.PreferencesGroup({
            title: _('Behaviour'),
            description: _('How the popup reacts to user actions'),
        });
        generalPage.add(behaviourGroup);
        behaviourGroup.add(createSwitchRow(
            window,
            settings,
            'focus-search-on-open',
            _('Focus the search field on open')
        ));
        behaviourGroup.add(createSwitchRow(
            window,
            settings,
            'close-after-copy',
            _('Close the popup after copying a code')
        ));

        const appearancePage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);

        const indicatorGroup = new Adw.PreferencesGroup({
            title: _('Panel Indicator'),
            description: _('Icon shown in the top panel'),
        });
        appearancePage.add(indicatorGroup);
        indicatorGroup.add(createComboRow(
            window,
            settings,
            'panel-icon',
            _('Icon'),
            PANEL_ICONS,
            [_('Password'), _('Secure channel'), _('Lock'), _('Smartcard')]
        ));

        const accountListGroup = new Adw.PreferencesGroup({
            title: _('Account List'),
            description: _('Configure the account rows'),
        });
        appearancePage.add(accountListGroup);
        accountListGroup.add(createComboRow(
            window,
            settings,
            'sort-by',
            _('Sort accounts by'),
            ['default', 'name', 'provider'],
            [_('As returned by Authenticator'), _('Account name'), _('Provider name')]
        ));
        accountListGroup.add(createSwitchRow(
            window,
            settings,
            'show-provider-name',
            _('Show provider name')
        ));
        accountListGroup.add(createComboRow(
            window,
            settings,
            'row-density',
            _('Row density'),
            ['comfortable', 'compact'],
            [_('Comfortable'), _('Compact')]
        ));
        accountListGroup.add(createComboRow(
            window,
            settings,
            'search-fields',
            _('Search in'),
            ['both', 'name', 'provider'],
            [_('Name and provider'), _('Name only'), _('Provider only')]
        ));
        accountListGroup.add(createSwitchRow(
            window,
            settings,
            'code-grouping',
            _('Group digits of the revealed code')
        ));
        accountListGroup.add(createSwitchRow(
            window,
            settings,
            'show-countdown-bar',
            _('Show the validity countdown bar')
        ));

        const rowsRow = Adw.SpinRow.new_with_range(3, 12, 1);
        rowsRow.title = _('Visible rows');
        rowsRow.subtitle = _('How many accounts the list shows without scrolling');
        settings.bind('popup-rows', rowsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        addResetButton(window, rowsRow, settings, 'popup-rows');
        accountListGroup.add(rowsRow);

        const openAppGroup = new Adw.PreferencesGroup({
            title: _('Open Authenticator'),
            description: _('Configure the shortcut that brings the app to the front'),
        });
        appearancePage.add(openAppGroup);
        openAppGroup.add(createSwitchRow(
            window,
            settings,
            'show-open-app-button',
            _('Show the open-app button')
        ));
        openAppGroup.add(createComboRow(
            window,
            settings,
            'open-app-icon',
            _('Icon'),
            OPEN_APP_ICONS,
            [_('Arrow'), _('New window'), _('External link'), _('Executable')]
        ));

        const shortcutsPage = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(shortcutsPage);

        const popupShortcutsGroup = new Adw.PreferencesGroup({
            title: _('Popup'),
            description: _('Keyboard shortcut for the Authenticator Companion popup'),
        });
        shortcutsPage.add(popupShortcutsGroup);
        popupShortcutsGroup.add(createShortcutRow(
            window,
            settings,
            'open-dialog-shortcut',
            _('Open or close the popup')
        ));

        const appShortcutsGroup = new Adw.PreferencesGroup({
            title: _('Open Authenticator'),
            description: _('Keyboard shortcut that brings the app window to the front'),
        });
        shortcutsPage.add(appShortcutsGroup);
        appShortcutsGroup.add(createShortcutRow(
            window,
            settings,
            'open-app-shortcut',
            _('Bring Authenticator to the front')
        ));
    }
}

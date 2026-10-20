// SPDX-License-Identifier: GPL-3.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AuthenticatorPopup} from './shell/popup.js';

export default class AuthenticatorCompanionExtension extends Extension {
    enable() {
        this._popup = new AuthenticatorPopup(this.getSettings(), this.uuid);
    }

    disable() {
        this._popup.destroy();
        this._popup = null;
    }
}

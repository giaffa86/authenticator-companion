// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const COPY_FEEDBACK_MS = 4000;
const LINE_ANIMATION_MS = 200;
// The provider has no period metadata; infer it after observing two rollovers.
const DEFAULT_PERIOD_MS = 30000;
const MIN_PERIOD_MS = 5000;
const MAX_PERIOD_MS = 300000;
const EXPIRY_WARNING_MS = 5000;

export const AccountMenuItem = GObject.registerClass(
class AccountMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(meta, {onReveal, onCopy, formatCode, showProviderName, showCountdown, rowDensity, searchFields, refreshInterval}) {
        super._init({style_class: 'authenticator-companion-item'});
        if (rowDensity === 'compact')
            this.add_style_class_name('compact');

        this.accountId = meta.id;
        this.accountName = meta.name;
        this.providerName = meta.description;

        this._onReveal = onReveal;
        this._onCopy = onCopy;
        this._formatCode = formatCode;
        this._showCountdown = showCountdown;
        this._searchFields = searchFields;
        this._refreshInterval = refreshInterval;

        this._code = null;
        this._revealed = false;
        this._copied = false;
        this._copyResetId = 0;
        this._copyExpiryMs = 0;
        this._actionToken = 0;
        this._periodMs = DEFAULT_PERIOD_MS;
        this._lastChangeMs = 0;
        this._codeLineShown = false;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._title = new St.Label({
            text: meta.name,
            style_class: 'authenticator-companion-title',
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._subtitle = new St.Label({
            text: meta.description,
            style_class: 'authenticator-companion-subtitle',
            visible: showProviderName,
        });
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._codeLabel = new St.Label({
            style_class: 'authenticator-companion-code',
            visible: false,
        });
        this._countdownTrack = new St.Bin({
            style_class: 'authenticator-companion-countdown-track',
            visible: false,
        });
        this._countdownFill = new St.Widget({
            style_class: 'authenticator-companion-countdown-fill',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            scale_x: 0,
        });
        this._countdownTrack.set_child(this._countdownFill);
        this._codeLine = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        this._codeLine.add_child(this._codeLabel);
        this._codeLine.add_child(this._countdownTrack);

        box.add_child(this._title);
        box.add_child(this._subtitle);
        box.add_child(this._codeLine);
        this.add_child(box);

        this._revealButton = new St.Button({
            style_class: 'authenticator-companion-reveal',
            toggle_mode: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
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
        this.connect('destroy', () => {
            if (this._copyResetId) {
                GLib.source_remove(this._copyResetId);
                this._copyResetId = 0;
            }
            this._code = null;
        });
    }

    get revealed() {
        return this._revealed;
    }

    get copied() {
        return this._copied;
    }

    /**
     * Claim this row for a new reveal/copy. Any earlier request's token is now
     * stale, so a late D-Bus reply cannot overwrite the newer action's result.
     */
    beginAction() {
        return ++this._actionToken;
    }

    isCurrentAction(token) {
        return token === this._actionToken;
    }

    matches(term) {
        const needle = term.toLowerCase();
        const name = this.accountName.toLowerCase();
        const provider = this.providerName.toLowerCase();
        switch (this._searchFields) {
        case 'name':
            return name.includes(needle);
        case 'provider':
            return provider.includes(needle);
        default:
            return name.includes(needle) || provider.includes(needle);
        }
    }

    setRevealed(revealed) {
        this._revealed = revealed;
        this._revealButton.checked = revealed;
        this._revealIcon.icon_name = revealed
            ? 'view-conceal-symbolic'
            : 'view-reveal-symbolic';
        this._revealButton.accessible_name = revealed ? _('Hide code') : _('Show code');
        this._renderCode();
        this.updateCountdown();
    }

    setCode(code) {
        const now = Date.now();
        if (this._code !== null && code !== this._code) {
            if (this._lastChangeMs) {
                const measured = Math.round((now - this._lastChangeMs) / 1000) * 1000;
                this._periodMs = Math.min(MAX_PERIOD_MS, Math.max(MIN_PERIOD_MS, measured));
            }
            this._lastChangeMs = now;
        } else if (this._code === null) {
            // A fresh code (first reveal, or after a copy dropped it): start
            // again from the standard period instead of a period measured for
            // a code the row no longer holds.
            this._periodMs = DEFAULT_PERIOD_MS;
            this._lastChangeMs = 0;
        }
        this._code = code;
        this._renderCode();
        this.updateCountdown();
    }

    forgetCode() {
        this._code = null;
    }

    clearCopied() {
        this._copied = false;
        this._copyExpiryMs = 0;
        if (this._copyResetId) {
            GLib.source_remove(this._copyResetId);
            this._copyResetId = 0;
        }
    }

    clearCode() {
        this._actionToken++;
        this._code = null;
        this._periodMs = DEFAULT_PERIOD_MS;
        this._lastChangeMs = 0;
        this.clearCopied();
        this.setRevealed(false);
    }

    _renderCode() {
        const showCopied = this._copied;
        const showCode = !showCopied && this._revealed && this._code !== null;
        this._codeLabel.visible = showCopied || showCode;
        if (showCopied) {
            this._codeLabel.text = _('Copied to clipboard');
            this._codeLabel.add_style_class_name('authenticator-companion-code-visible');
        } else if (showCode) {
            this._codeLabel.text = this._formatCode(this._code);
            this._codeLabel.add_style_class_name('authenticator-companion-code-visible');
        } else {
            this._codeLabel.text = '';
            this._codeLabel.remove_style_class_name('authenticator-companion-code-visible');
        }
        this._syncCodeLine();
    }

    _syncCodeLine() {
        const shown = this._codeLabel.visible || this._countdownTrack.visible;
        if (shown === this._codeLineShown)
            return;
        this._codeLineShown = shown;
        this._codeLine.remove_all_transitions();
        if (shown) {
            this._codeLine.visible = true;
            this._codeLine.opacity = 0;
            this._codeLine.translation_y = 8;
            this._codeLine.ease({
                opacity: 255,
                translation_y: 0,
                duration: LINE_ANIMATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._codeLine.ease({
                opacity: 0,
                translation_y: 8,
                duration: LINE_ANIMATION_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (!this._codeLineShown)
                        this._codeLine.visible = false;
                },
            });
        }
    }

    /**
     * Remaining validity of the shown code. The measured period is only as
     * exact as the 1 s polling that observes the changes, so once a change has
     * been seen the countdown is anchored to it rather than re-derived from
     * `epoch % period`, where a one-second error would turn into a wrong bar.
     * A copied code keeps the expiry recorded at copy time and stops at zero
     * instead of refilling after the rollover.
     */
    _remainingMs() {
        const now = Date.now();
        if (this._copied && this._copyExpiryMs)
            return Math.max(0, this._copyExpiryMs - now);
        if (this._lastChangeMs)
            return this._periodMs - ((now - this._lastChangeMs) % this._periodMs);
        return this._periodMs - (now % this._periodMs);
    }

    updateCountdown() {
        // The bar also stays under the "Copied" confirmation: the copied code
        // has the same remaining validity and the row still holds no code, only
        // the period it had already measured.
        const shown = this._showCountdown &&
            (this._copied || (this._revealed && this._code !== null));
        this._countdownTrack.visible = shown;
        this._syncCodeLine();
        if (!shown)
            return;

        const remaining = this._remainingMs();
        // Scale the fill within the track's allocation. Pixel widths measured
        // before the newly visible code line is laid out become stale as the
        // popup resizes, and otherwise stay wrong until the next polling tick.
        this._animateCountdownFill(remaining / this._periodMs);
        if (remaining <= EXPIRY_WARNING_MS)
            this._countdownFill.add_style_class_name('warning');
        else
            this._countdownFill.remove_style_class_name('warning');
    }

    _animateCountdownFill(fraction) {
        if (fraction === this._countdownFill.scale_x)
            return;
        this._countdownFill.remove_all_transitions();
        if (fraction > this._countdownFill.scale_x || this._countdownFill.scale_x === 0) {
            this._countdownFill.scale_x = fraction;
            return;
        }
        this._countdownFill.ease({
            scale_x: fraction,
            duration: this._refreshInterval,
            mode: Clutter.AnimationMode.LINEAR,
        });
    }

    flashCopied() {
        this.clearCopied();
        const expiry = Date.now() + this._remainingMs();
        this._copied = true;
        this._copyExpiryMs = expiry;
        this._renderCode();
        this.updateCountdown();
        this._copyResetId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            COPY_FEEDBACK_MS,
            () => {
                this._copyResetId = 0;
                this._copied = false;
                this._copyExpiryMs = 0;
                this._renderCode();
                this.updateCountdown();
                return GLib.SOURCE_REMOVE;
            });
    }
});

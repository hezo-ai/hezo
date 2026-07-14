import { useCallback, useEffect, useState } from 'react';
import {
	type BeforeInstallPromptEvent,
	consumeInstallEvent,
	getBufferedInstallEvent,
	INSTALLABLE_EVENT,
	INSTALLED_EVENT,
	wasInstalled,
} from '../lib/install-prompt-store';
import { readStored, writeStored } from '../lib/safe-storage';

const DISMISS_KEY = 'hezo:pwa-install-dismissed';
/** Once dismissed, stay quiet for this many days before offering again. */
const COOLDOWN_DAYS = 14;

/** Local calendar-day key (YYYY-MM-DD in the viewer's timezone). */
function todayKey(): string {
	return new Date().toLocaleDateString('en-CA');
}

/** True if the stored dismissal is still inside the cooldown window. */
function isDismissed(): boolean {
	const day = readStored(DISMISS_KEY);
	if (!day) return false;
	const then = new Date(`${day}T00:00:00`);
	if (Number.isNaN(then.getTime())) return false;
	const ageDays = (Date.now() - then.getTime()) / 86_400_000;
	return ageDays < COOLDOWN_DAYS;
}

/** True when the app is already running as an installed/standalone PWA. */
function isStandalone(): boolean {
	if (typeof window === 'undefined') return false;
	// The inline capture script may have already seen `appinstalled` this session.
	if (wasInstalled()) return true;
	const mql = window.matchMedia?.('(display-mode: standalone)');
	if (mql?.matches) return true;
	// iOS Safari exposes its own flag rather than the display-mode media query.
	return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iOS (incl. iPadOS, which now reports a desktop UA but has touch points). */
function isIos(): boolean {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent;
	if (/iphone|ipad|ipod/i.test(ua)) return true;
	return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export interface InstallPromptState {
	/**
	 * Which install affordance to offer, or `null` when nothing should show
	 * (already installed, dismissed within the cooldown, or not installable).
	 * `'android'` → a native prompt is available; `'ios'` → manual
	 * Share → Add to Home Screen instructions.
	 */
	platform: 'android' | 'ios' | null;
	/** Trigger the native install dialog. No-op on iOS (no programmatic prompt). */
	promptInstall: () => Promise<void>;
	/** Dismiss the prompt for the cooldown window. */
	dismiss: () => void;
}

/**
 * Drives the mobile "install Hezo to your home screen" prompt. Captures the
 * Chrome/Android `beforeinstallprompt` event for a one-tap install, falls back
 * to iOS Safari's manual Add-to-Home-Screen instructions, and stays silent once
 * the app is installed or the user has dismissed it recently.
 */
export function useInstallPrompt(): InstallPromptState {
	// Seed from the buffer captured by the inline script in index.html: Chrome may
	// have fired `beforeinstallprompt` before this hook (or React itself) mounted.
	const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
		getBufferedInstallEvent,
	);
	const [dismissed, setDismissed] = useState<boolean>(isDismissed);
	const [standalone, setStandalone] = useState<boolean>(isStandalone);

	useEffect(() => {
		if (typeof window === 'undefined') return;

		// The inline script owns the raw `beforeinstallprompt`/`appinstalled`
		// listeners (and has already called preventDefault); we react to its
		// buffered state via these custom events, plus a mount-time re-read to
		// close any gap between the buffer updating and this effect subscribing.
		const onInstallable = () => setDeferred(getBufferedInstallEvent());
		const onInstalled = () => {
			setDeferred(null);
			setStandalone(true);
		};

		window.addEventListener(INSTALLABLE_EVENT, onInstallable);
		window.addEventListener(INSTALLED_EVENT, onInstalled);
		setDeferred(getBufferedInstallEvent());
		return () => {
			window.removeEventListener(INSTALLABLE_EVENT, onInstallable);
			window.removeEventListener(INSTALLED_EVENT, onInstalled);
		};
	}, []);

	const dismiss = useCallback(() => {
		writeStored(DISMISS_KEY, todayKey());
		setDismissed(true);
	}, []);

	const promptInstall = useCallback(async () => {
		// Consume the buffered event (single-use per the browser's contract).
		const event = consumeInstallEvent();
		setDeferred(null);
		if (!event) return;
		await event.prompt();
		await event.userChoice;
	}, []);

	let platform: InstallPromptState['platform'] = null;
	if (!standalone && !dismissed) {
		if (deferred) platform = 'android';
		else if (isIos()) platform = 'ios';
	}

	return { platform, promptInstall, dismiss };
}

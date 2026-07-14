/**
 * Typed accessor over the PWA install signal buffered by the inline script in
 * `index.html`. That script captures Chrome's `beforeinstallprompt` (and
 * `appinstalled`) at the earliest possible moment — before this bundle loads —
 * because the event fires once, early in page load, and is lost if nothing
 * catches it in that instant. Here we expose the buffer to React so
 * `useInstallPrompt` can read an event that already fired before it mounted.
 */

/**
 * The non-standard `beforeinstallprompt` event isn't in lib.dom. Chrome/Android
 * fires it when the page is installable; the inline script suppresses the
 * browser's default mini-infobar and we replay it from our own UI via `prompt()`.
 */
export interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
	prompt(): Promise<void>;
}

interface InstallBuffer {
	event: BeforeInstallPromptEvent | null;
	installed: boolean;
}

declare global {
	interface Window {
		__hezoInstall?: InstallBuffer;
	}
}

/** Fired by the inline script when a `beforeinstallprompt` has been buffered. */
export const INSTALLABLE_EVENT = 'hezo:installable';
/** Fired by the inline script when the app has been installed. */
export const INSTALLED_EVENT = 'hezo:installed';

/** The buffered install event, or `null` if none has fired (or it's been consumed). */
export function getBufferedInstallEvent(): BeforeInstallPromptEvent | null {
	if (typeof window === 'undefined') return null;
	return window.__hezoInstall?.event ?? null;
}

/**
 * Return the buffered install event and clear it. The browser's
 * `beforeinstallprompt` can only be used once, so consumption is single-shot.
 */
export function consumeInstallEvent(): BeforeInstallPromptEvent | null {
	if (typeof window === 'undefined') return null;
	const buffer = window.__hezoInstall;
	if (!buffer) return null;
	const event = buffer.event;
	buffer.event = null;
	return event;
}

/** True once the app has been installed (the inline script saw `appinstalled`). */
export function wasInstalled(): boolean {
	if (typeof window === 'undefined') return false;
	return window.__hezoInstall?.installed === true;
}

import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { PwaInstallPrompt } from '../src/components/pwa-install-prompt';

const DISMISS_KEY = 'hezo:pwa-install-dismissed';
const REAL_UA = navigator.userAgent;

function today(): string {
	return new Date().toLocaleDateString('en-CA');
}

/** A stand-in for the non-standard `beforeinstallprompt` event. */
class FakeBeforeInstallPromptEvent extends Event {
	platforms = ['web'];
	userChoice = Promise.resolve({ outcome: 'accepted' as const, platform: 'web' });
	prompt = vi.fn().mockResolvedValue(undefined);
	constructor() {
		super('beforeinstallprompt');
	}
}

/**
 * Seed the install buffer the way the inline `index.html` script would, without
 * dispatching the notify event — mirrors an event that fired before React mounted.
 */
function seedBuffer(evt: FakeBeforeInstallPromptEvent): void {
	window.__hezoInstall = { event: evt, installed: false };
}

/**
 * Buffer a synthetic install event and fire the `hezo:installable` signal the
 * inline script emits, so the hook captures it (Android path).
 */
function fireBeforeInstallPrompt(): FakeBeforeInstallPromptEvent {
	const evt = new FakeBeforeInstallPromptEvent();
	seedBuffer(evt);
	act(() => {
		window.dispatchEvent(new Event('hezo:installable'));
	});
	return evt;
}

function setUserAgent(value: string): void {
	Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => value });
}

/** Make `matchMedia('(display-mode: standalone)')` report installed/standalone. */
function stubStandalone(matches: boolean): void {
	vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
		matches: matches && query.includes('standalone'),
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
}

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
	setUserAgent(REAL_UA);
	window.__hezoInstall = undefined;
});

test('nothing renders until the app is installable', () => {
	const { queryByTestId } = render(<PwaInstallPrompt />);
	expect(queryByTestId('pwa-install-prompt')).toBeNull();
});

test('Android: shows an Install button once beforeinstallprompt fires', () => {
	const { queryByTestId, getByTestId } = render(<PwaInstallPrompt />);
	expect(queryByTestId('pwa-install-prompt')).toBeNull();
	fireBeforeInstallPrompt();
	expect(getByTestId('pwa-install-prompt')).toBeTruthy();
	expect(getByTestId('pwa-install-button')).toBeTruthy();
});

// Regression: Chrome fires `beforeinstallprompt` once, early in page load — often
// before React mounts. The inline capture script buffers it; the hook must read
// that buffer on first render, with no post-mount dispatch at all.
test('Android: shows the card when beforeinstallprompt fired before mount', () => {
	seedBuffer(new FakeBeforeInstallPromptEvent());
	const { getByTestId } = render(<PwaInstallPrompt />);
	expect(getByTestId('pwa-install-prompt')).toBeTruthy();
	expect(getByTestId('pwa-install-button')).toBeTruthy();
});

test('Android: clicking Install replays the captured prompt', async () => {
	const user = userEvent.setup();
	const { getByTestId } = render(<PwaInstallPrompt />);
	const evt = fireBeforeInstallPrompt();
	await user.click(getByTestId('pwa-install-button'));
	expect(evt.prompt).toHaveBeenCalledTimes(1);
});

test('iOS: shows manual Add to Home Screen instructions and no Install button', () => {
	setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
	const { getByTestId, queryByTestId } = render(<PwaInstallPrompt />);
	const card = getByTestId('pwa-install-prompt');
	expect(card.textContent).toContain('Add to Home Screen');
	expect(queryByTestId('pwa-install-button')).toBeNull();
});

test('hidden when already running as an installed standalone app', () => {
	setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
	stubStandalone(true);
	const { queryByTestId } = render(<PwaInstallPrompt />);
	expect(queryByTestId('pwa-install-prompt')).toBeNull();
});

test('dismiss hides the prompt and records the day', async () => {
	const user = userEvent.setup();
	const { getByTestId, queryByTestId } = render(<PwaInstallPrompt />);
	fireBeforeInstallPrompt();
	expect(getByTestId('pwa-install-prompt')).toBeTruthy();
	await user.click(getByTestId('pwa-install-dismiss'));
	expect(queryByTestId('pwa-install-prompt')).toBeNull();
	expect(localStorage.getItem(DISMISS_KEY)).toBe(today());
});

test('a recent dismissal keeps the prompt hidden', () => {
	localStorage.setItem(DISMISS_KEY, today());
	const { queryByTestId } = render(<PwaInstallPrompt />);
	fireBeforeInstallPrompt();
	expect(queryByTestId('pwa-install-prompt')).toBeNull();
});

test('a dismissal past the cooldown window no longer suppresses the prompt', () => {
	localStorage.setItem(DISMISS_KEY, '2000-01-01');
	const { getByTestId } = render(<PwaInstallPrompt />);
	fireBeforeInstallPrompt();
	expect(getByTestId('pwa-install-prompt')).toBeTruthy();
});

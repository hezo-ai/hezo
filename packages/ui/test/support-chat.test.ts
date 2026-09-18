import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as SupportChat from '../src/support-chat.js';

// The loader keeps module state for the life of a page, so each spec imports a
// fresh copy and removes the listeners the previous copy left on the window.
// The widget script itself never loads here: happy-dom reports the blocked
// load as a success, and each spec stands in for what the script would define.

interface FakeChatwoot {
	setUser: ReturnType<typeof vi.fn>;
	toggle: ReturnType<typeof vi.fn>;
	setLocale: ReturnType<typeof vi.fn>;
	setColorScheme: ReturnType<typeof vi.fn>;
	reset: ReturnType<typeof vi.fn>;
}

interface TestWindow {
	chatwootSettings?: Record<string, unknown>;
	chatwootSDK?: { run: ReturnType<typeof vi.fn> };
	$chatwoot?: FakeChatwoot;
	happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
}

const testWindow = window as unknown as TestWindow;

const OPTIONS: SupportChat.SupportChatOptions = {
	baseUrl: 'https://chat.example/',
	websiteToken: 'website-token',
	sdkIntegrity: 'sha384-abc sha384-def',
	identity: {
		identifier: 'contact-1',
		identifierHash: 'f'.repeat(64),
		name: 'Ada',
		email: 'ada@example.com',
	},
	locale: 'pt-BR',
	colorScheme: 'dark',
	hideBubble: true,
};

const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
let chat: typeof SupportChat;
let fake: FakeChatwoot;

beforeEach(async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const add = window.addEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
		if (listener) listeners.push([type, listener]);
		add(type, listener, options);
	});

	fake = {
		setUser: vi.fn(),
		toggle: vi.fn(),
		setLocale: vi.fn(),
		setColorScheme: vi.fn(),
		reset: vi.fn(),
	};
	testWindow.chatwootSDK = {
		run: vi.fn(() => {
			testWindow.$chatwoot = fake;
		}),
	};

	vi.resetModules();
	chat = await import('../src/support-chat.js');
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
	for (const script of document.head.querySelectorAll('script')) script.remove();
	delete testWindow.chatwootSettings;
	delete testWindow.chatwootSDK;
	delete testWindow.$chatwoot;
});

function scripts(): HTMLScriptElement[] {
	return [...document.head.querySelectorAll('script')];
}

/** Resolve once the script's load has fired and the SDK has run. */
async function loaded(): Promise<void> {
	await vi.waitFor(() => expect(testWindow.$chatwoot).toBeDefined());
}

function ready(): void {
	window.dispatchEvent(new Event('chatwoot:ready'));
}

test('loads the widget script under integrity, without credentials', () => {
	chat.installSupportChat(OPTIONS);

	const [script] = scripts();
	expect(script.getAttribute('src')).toBe('https://chat.example/packs/js/sdk.js');
	expect(script.getAttribute('integrity')).toBe('sha384-abc sha384-def');
	expect(script.getAttribute('crossorigin')).toBe('anonymous');
});

test('hands the widget its settings, and never a cookie domain', () => {
	chat.installSupportChat(OPTIONS);

	expect(testWindow.chatwootSettings).toEqual({
		locale: 'pt_BR',
		darkMode: 'dark',
		hideMessageBubble: true,
	});
	// A cookie domain would share the conversation cookie with every sibling host.
	expect(testWindow.chatwootSettings).not.toHaveProperty('baseDomain');
});

test('runs the SDK once the script loads', async () => {
	chat.installSupportChat(OPTIONS);
	await loaded();

	expect(testWindow.chatwootSDK?.run).toHaveBeenCalledWith({
		websiteToken: 'website-token',
		baseUrl: 'https://chat.example',
	});
});

test('identifies the person when the widget is ready', async () => {
	chat.installSupportChat(OPTIONS);
	await loaded();
	expect(fake.setUser).not.toHaveBeenCalled();

	ready();
	expect(fake.setUser).toHaveBeenCalledWith('contact-1', {
		name: 'Ada',
		email: 'ada@example.com',
		identifier_hash: 'f'.repeat(64),
	});
});

test('sends only the identity fields it has', async () => {
	chat.installSupportChat({
		...OPTIONS,
		identity: { identifier: 'contact-1', identifierHash: 'f'.repeat(64), email: 'ada@example.com' },
	});
	await loaded();
	ready();

	expect(fake.setUser).toHaveBeenCalledWith('contact-1', {
		email: 'ada@example.com',
		identifier_hash: 'f'.repeat(64),
	});
});

test('installs once per page', async () => {
	chat.installSupportChat(OPTIONS);
	chat.installSupportChat({ ...OPTIONS, websiteToken: 'another-token' });
	await loaded();
	ready();

	expect(scripts()).toHaveLength(1);
	expect(testWindow.chatwootSDK?.run).toHaveBeenCalledTimes(1);
	expect(fake.setUser).toHaveBeenCalledTimes(1);
});

test('opens now when ready, and on ready when asked early', async () => {
	chat.installSupportChat(OPTIONS);
	chat.openSupportChat();
	await loaded();
	expect(fake.toggle).not.toHaveBeenCalled();

	ready();
	expect(fake.toggle).toHaveBeenCalledWith('open');

	chat.openSupportChat();
	expect(fake.toggle).toHaveBeenCalledTimes(2);
});

test('applies a locale or scheme change made while the widget loaded', async () => {
	chat.installSupportChat(OPTIONS);
	chat.setSupportChatLocale('zh-Hans');
	chat.setSupportChatTheme('light');
	await loaded();
	ready();

	expect(fake.setLocale).toHaveBeenLastCalledWith('zh_CN');
	expect(fake.setColorScheme).toHaveBeenLastCalledWith('light');

	chat.setSupportChatLocale('en');
	chat.setSupportChatTheme('dark');
	expect(fake.setLocale).toHaveBeenLastCalledWith('en');
	expect(fake.setColorScheme).toHaveBeenLastCalledWith('dark');
});

test('reset forgets the person, and a later install identifies the next one', async () => {
	chat.installSupportChat(OPTIONS);
	await loaded();
	ready();
	chat.resetSupportChat();
	expect(fake.reset).toHaveBeenCalledTimes(1);

	// The widget reloads after a reset; the previous person must not come back.
	fake.setUser.mockClear();
	ready();
	expect(fake.setUser).not.toHaveBeenCalled();

	chat.installSupportChat({
		...OPTIONS,
		identity: { identifier: 'contact-2', identifierHash: 'e'.repeat(64), name: 'Grace' },
	});
	expect(fake.setUser).toHaveBeenCalledWith('contact-2', {
		name: 'Grace',
		identifier_hash: 'e'.repeat(64),
	});
	expect(scripts()).toHaveLength(1);
});

test('never throws, whether the widget is absent or failing', async () => {
	// Before install, and with no widget at all.
	expect(() => {
		chat.openSupportChat();
		chat.resetSupportChat();
		chat.setSupportChatTheme('light');
		chat.setSupportChatLocale('de');
	}).not.toThrow();

	// A widget whose every method throws, as its identify call does on bad input.
	const boom = () => {
		throw new Error('widget fault');
	};
	fake.setUser.mockImplementation(boom);
	fake.toggle.mockImplementation(boom);
	fake.setLocale.mockImplementation(boom);
	fake.setColorScheme.mockImplementation(boom);
	fake.reset.mockImplementation(boom);
	chat.installSupportChat(OPTIONS);
	await loaded();

	expect(() => {
		ready();
		chat.openSupportChat();
		chat.setSupportChatTheme('light');
		chat.setSupportChatLocale('de');
		chat.resetSupportChat();
	}).not.toThrow();
});

test('a script that loads without defining the SDK leaves the page alone', async () => {
	delete testWindow.chatwootSDK;
	chat.installSupportChat(OPTIONS);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(testWindow.$chatwoot).toBeUndefined();
	expect(() => {
		ready();
		chat.openSupportChat();
	}).not.toThrow();
});

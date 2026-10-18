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
	toggleBubbleVisibility: ReturnType<typeof vi.fn>;
	setCustomAttributes: ReturnType<typeof vi.fn>;
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
		toggleBubbleVisibility: vi.fn(),
		setCustomAttributes: vi.fn(),
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
	vi.useRealTimers();
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

function widgetEvent(name: 'opened' | 'closed' | 'on-start-conversation'): void {
	window.dispatchEvent(new Event(`chatwoot:${name}`));
}

const CONTEXT = {
	hezo_surface: 'instance',
	hezo_screen: '/projects/$projectId/tasks/$taskId',
	hezo_project: 'launch',
	hezo_version: null,
};

const SENT = {
	hezo_surface: 'instance',
	hezo_screen: '/projects/$projectId/tasks/$taskId',
	hezo_project: 'launch',
	hezo_version: '',
};

/** Install named, report ready, and let the hold after naming the person pass. */
async function readyChat(): Promise<void> {
	chat.installSupportChat(OPTIONS);
	await loaded();
	vi.useFakeTimers();
	ready();
	vi.advanceTimersByTime(chat.SUPPORT_CHAT_IDENTIFY_SETTLE_MS);
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

// A page reached before signing in has nobody to name, and the widget has to
// load there anyway: that is where somebody locked out asks why.
test('loads with nobody named, and names nobody', async () => {
	const { identity: _, ...anonymous } = OPTIONS;
	chat.installSupportChat(anonymous);
	await loaded();
	ready();

	expect(scripts()).toHaveLength(1);
	expect(fake.setUser).not.toHaveBeenCalled();
});

test('adopts an identity handed to the install already running', async () => {
	const { identity: _, ...anonymous } = OPTIONS;
	chat.installSupportChat(anonymous);
	await loaded();
	ready();

	// Signing in on the same page: the conversation already open becomes theirs
	// rather than being left beside a second one.
	chat.installSupportChat(OPTIONS);
	expect(fake.setUser).toHaveBeenCalledWith('contact-1', {
		name: 'Ada',
		email: 'ada@example.com',
		identifier_hash: 'f'.repeat(64),
	});
	expect(scripts()).toHaveLength(1);
});

// Identifying can fold the anonymous contact into the person's existing one,
// keeping that one's values; a separate write racing the merge can land on the
// contact that goes. Inside the identifying request it is applied after.
test('the context of an open panel rides the request that names the person', async () => {
	const { identity: _, ...anonymous } = OPTIONS;
	chat.installSupportChat(anonymous);
	await loaded();
	ready();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);

	chat.installSupportChat(OPTIONS);
	expect(fake.setUser).toHaveBeenCalledWith('contact-1', {
		name: 'Ada',
		email: 'ada@example.com',
		identifier_hash: 'f'.repeat(64),
		custom_attributes: SENT,
	});
	// The same context is not sent a second time beside it.
	chat.setSupportChatContext(CONTEXT);
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);
});

// The widget says nothing when the merge is done, so a change made meanwhile
// waits a while and then goes on its own, to the contact that is left.
test('a change made while the person is being named waits for the merge', async () => {
	const { identity: _, ...anonymous } = OPTIONS;
	chat.installSupportChat(anonymous);
	await loaded();
	vi.useFakeTimers();
	ready();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);

	chat.installSupportChat(OPTIONS);
	chat.setSupportChatContext({ ...CONTEXT, hezo_screen: '/projects/$projectId' });
	widgetEvent('opened');
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);

	vi.advanceTimersByTime(chat.SUPPORT_CHAT_IDENTIFY_SETTLE_MS);
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(2);
	expect(fake.setCustomAttributes).toHaveBeenLastCalledWith({
		...SENT,
		hezo_screen: '/projects/$projectId',
	});
});

test('a panel asked open before the widget was ready also waits for the merge', async () => {
	chat.installSupportChat(OPTIONS);
	chat.openSupportChat();
	chat.setSupportChatContext(CONTEXT);
	await loaded();
	vi.useFakeTimers();
	ready();
	widgetEvent('opened');
	expect(fake.setCustomAttributes).not.toHaveBeenCalled();

	vi.advanceTimersByTime(chat.SUPPORT_CHAT_IDENTIFY_SETTLE_MS);
	expect(fake.setCustomAttributes).toHaveBeenCalledWith(SENT);
});

// An open soon after a signed-in page loads would race the same merge.
test('an open soon after the person is named waits for the merge', async () => {
	chat.installSupportChat(OPTIONS);
	await loaded();
	vi.useFakeTimers();
	ready();
	chat.setSupportChatContext(CONTEXT);
	widgetEvent('opened');
	expect(fake.setCustomAttributes).not.toHaveBeenCalled();

	vi.advanceTimersByTime(chat.SUPPORT_CHAT_IDENTIFY_SETTLE_MS);
	expect(fake.setCustomAttributes).toHaveBeenCalledWith(SENT);
});

test('a closed panel names the person and sends nothing about where they are', async () => {
	const { identity: _, ...anonymous } = OPTIONS;
	chat.installSupportChat(anonymous);
	await loaded();
	ready();
	chat.setSupportChatContext(CONTEXT);

	chat.installSupportChat(OPTIONS);
	expect(fake.setUser.mock.lastCall?.[1]).not.toHaveProperty('custom_attributes');
});

test('an identity already held is not replaced by a later anonymous install', async () => {
	chat.installSupportChat(OPTIONS);
	await loaded();
	ready();
	fake.setUser.mockClear();

	const { identity: _, ...anonymous } = OPTIONS;
	chat.installSupportChat(anonymous);
	expect(fake.setUser).not.toHaveBeenCalled();
});

test('shows and hides the launcher after the widget has loaded', async () => {
	chat.installSupportChat(OPTIONS);
	await loaded();
	ready();

	chat.setSupportChatBubble(false);
	expect(fake.toggleBubbleVisibility).toHaveBeenLastCalledWith('hide');
	chat.setSupportChatBubble(true);
	expect(fake.toggleBubbleVisibility).toHaveBeenLastCalledWith('show');
});

test('keeps where the person is to itself until the chat opens', async () => {
	await readyChat();
	chat.setSupportChatContext(CONTEXT);
	expect(fake.setCustomAttributes).not.toHaveBeenCalled();

	widgetEvent('opened');
	expect(fake.setCustomAttributes).toHaveBeenCalledWith(SENT);
});

test('sends the whole context on every change, never a part of it', async () => {
	await readyChat();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);
	chat.setSupportChatContext({ ...CONTEXT, hezo_project: 'billing' });

	// The inbox replaces a conversation's attributes with what it is sent, so a
	// change to one key still carries every other.
	expect(fake.setCustomAttributes).toHaveBeenLastCalledWith({
		...SENT,
		hezo_project: 'billing',
	});
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(2);
});

test('does not send a context it already sent while the panel stays open', async () => {
	await readyChat();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);
	chat.setSupportChatContext({
		hezo_version: null,
		hezo_project: 'launch',
		hezo_screen: '/projects/$projectId/tasks/$taskId',
		hezo_surface: 'instance',
	});

	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);
});

// The widget sends the attributes in a request of its own and swallows a
// failure, so a call that went through may still not have arrived.
test('sends the context on every open, changed or not', async () => {
	await readyChat();
	chat.setSupportChatContext(CONTEXT);
	widgetEvent('opened');
	widgetEvent('closed');
	widgetEvent('opened');

	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(2);
	expect(fake.setCustomAttributes).toHaveBeenLastCalledWith(SENT);
});

test('holds changes made while the chat is closed until it opens again', async () => {
	await readyChat();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);
	widgetEvent('closed');

	chat.setSupportChatContext({ ...CONTEXT, hezo_project: 'billing' });
	chat.setSupportChatContext({ ...CONTEXT, hezo_project: 'growth' });
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);

	widgetEvent('opened');
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(2);
	expect(fake.setCustomAttributes).toHaveBeenLastCalledWith({
		...SENT,
		hezo_project: 'growth',
	});
});

test('tries a send the widget refused again, rather than counting it as sent', async () => {
	await readyChat();
	fake.setCustomAttributes.mockImplementationOnce(() => {
		throw new Error('widget fault');
	});
	chat.setSupportChatContext(CONTEXT);
	widgetEvent('opened');
	widgetEvent('closed');

	// Nothing on the page changed, but the first send never reached the widget.
	widgetEvent('opened');
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(2);
	expect(fake.setCustomAttributes).toHaveBeenLastCalledWith(SENT);
});

// The attributes are the contact's, which a new conversation does not reset,
// and the panel was already open to start it.
test('a conversation starting sends nothing it has not already sent', async () => {
	await readyChat();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);
	widgetEvent('on-start-conversation');

	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);
});

test('after a reset, the next person is sent the context when they open the chat', async () => {
	await readyChat();
	widgetEvent('opened');
	chat.setSupportChatContext(CONTEXT);
	chat.resetSupportChat();

	chat.setSupportChatContext(CONTEXT);
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(1);
	ready();
	widgetEvent('opened');
	expect(fake.setCustomAttributes).toHaveBeenCalledTimes(2);
});

test('never sends an empty context, which the widget refuses', async () => {
	await readyChat();
	widgetEvent('opened');
	chat.setSupportChatContext({});

	expect(fake.setCustomAttributes).not.toHaveBeenCalled();
});

test('does nothing with a context before install', () => {
	expect(() => chat.setSupportChatContext(CONTEXT)).not.toThrow();
	widgetEvent('opened');
	expect(fake.setCustomAttributes).not.toHaveBeenCalled();
});

test('never throws, whether the widget is absent or failing', async () => {
	// Before install, and with no widget at all.
	expect(() => {
		chat.openSupportChat();
		chat.resetSupportChat();
		chat.setSupportChatTheme('light');
		chat.setSupportChatLocale('de');
		chat.setSupportChatContext(CONTEXT);
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
	fake.setCustomAttributes.mockImplementation(boom);
	chat.installSupportChat(OPTIONS);
	await loaded();

	expect(() => {
		ready();
		chat.openSupportChat();
		chat.setSupportChatTheme('light');
		chat.setSupportChatLocale('de');
		widgetEvent('opened');
		chat.setSupportChatContext(CONTEXT);
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

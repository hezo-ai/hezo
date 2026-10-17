import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as Analytics from '../src/analytics.js';

// The loader keeps module state for the life of a page, so each spec imports a
// fresh copy and removes the listeners the previous copy left on the document.
// The tracker and recorder scripts never load here: happy-dom reports the
// blocked load as a success, and a stand-in tracker defines the runtime API the
// real one would.

type Payload = Record<string, unknown>;
type TrackArgument = string | ((payload: Payload) => Payload) | undefined;

interface TestWindow {
	umami?: { track: ReturnType<typeof vi.fn> };
	happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
	[hook: string]: unknown;
}

const testWindow = window as unknown as TestWindow;

const PATTERN = '/projects/$projectId/tasks/$taskId';

const listeners: Array<[string, EventListenerOrEventListenerObject, boolean | undefined]> = [];
let analytics: typeof Analytics;
let track: ReturnType<typeof vi.fn>;
let page: string;
let hookName: string | null = null;

function options(): Analytics.AnalyticsOptions {
	return {
		host: 'https://stats.example/hz/',
		websiteId: '2d1f3c4b-5a69-4f7e-8d9c-0b1a2c3d4e5f',
		distinctId: 'account-1',
		pagePattern: () => page,
	};
}

beforeEach(async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const add = document.addEventListener.bind(document);
	vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, capture) => {
		if (listener) listeners.push([type, listener, typeof capture === 'boolean' ? capture : true]);
		add(type, listener, capture);
	});
	sessionStorage.clear();
	page = PATTERN;
	track = vi.fn();
	testWindow.umami = { track };

	vi.resetModules();
	analytics = await import('../src/analytics.js');
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const [type, listener, capture] of listeners.splice(0)) {
		document.removeEventListener(type, listener, capture);
	}
	for (const script of document.head.querySelectorAll('script')) script.remove();
	document.documentElement.classList.remove('rr-mask');
	document.body.innerHTML = '';
	delete testWindow.umami;
	if (hookName) delete testWindow[hookName];
	hookName = null;
	sessionStorage.clear();
});

function scriptAt(path: string): HTMLScriptElement[] {
	return [...document.head.querySelectorAll<HTMLScriptElement>(`script[src="${path}"]`)];
}

function tracker(): HTMLScriptElement {
	const [script] = scriptAt('https://stats.example/hz/script.js');
	return script;
}

/** Install, and resolve once the stand-in tracker has had its queue flushed. */
async function installed(): Promise<void> {
	analytics.installAnalytics(options());
	hookName = tracker().getAttribute('data-before-send');
	await vi.waitFor(() => expect(track).toHaveBeenCalled());
}

/** The hook the real tracker would call before every send. */
function beforeSend(type: string, payload: Payload): Payload | false {
	const name = tracker().getAttribute('data-before-send') ?? '';
	const hook = testWindow[name] as (type: string, payload: Payload) => Payload | false;
	return hook(type, payload);
}

function clickOn(element: Element): void {
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

test('the never-record and mask classes are the recorder defaults', () => {
	expect(analytics.NEVER_RECORD_CLASS).toBe('rr-block');
	expect(analytics.MASK_TEXT_CLASS).toBe('rr-mask');
	expect(analytics.ANALYTICS_ATTRIBUTE).toBe('data-analytics');
});

test('loads the tracker once, carrying what the tracker reads off its tag', () => {
	analytics.installAnalytics(options());
	analytics.installAnalytics({ ...options(), websiteId: 'another-website' });

	expect(scriptAt('https://stats.example/hz/script.js')).toHaveLength(1);
	const script = tracker();
	expect(script.getAttribute('data-website-id')).toBe('2d1f3c4b-5a69-4f7e-8d9c-0b1a2c3d4e5f');
	expect(script.getAttribute('data-distinct-id')).toBe('account-1');
	expect(script.defer).toBe(true);
	// The page reports its own route changes; the tracker's history hook would
	// count some of them twice and back and forward not at all.
	expect(script.getAttribute('data-auto-track')).toBe('false');
	hookName = script.getAttribute('data-before-send');
	expect(hookName).toBeTruthy();
	expect(typeof testWindow[hookName ?? '']).toBe('function');
});

test('reports the page the visit starts on once the tracker has loaded, and calls made before it', async () => {
	// Hold the script back, so there is a window in which the tracker is not there.
	const held: Node[] = [];
	const append = document.head.appendChild.bind(document.head);
	const spy = vi
		.spyOn(document.head, 'appendChild')
		.mockImplementation(<T extends Node>(node: T) => {
			held.push(node);
			return node;
		});
	analytics.installAnalytics(options());
	analytics.trackAnalyticsEvent('create-task');
	expect(track).not.toHaveBeenCalled();

	spy.mockRestore();
	for (const node of held) append(node);
	await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2));
	expect(track.mock.calls[0]).toEqual([]);
	expect(track.mock.calls[1]).toEqual(['create-task']);
});

test('later page views go straight to the tracker, without the referrer the page loaded with', async () => {
	await installed();
	track.mockClear();

	analytics.trackAnalyticsPageView();
	expect(track).toHaveBeenCalledTimes(1);
	const build = track.mock.calls[0][0] as TrackArgument;
	expect(typeof build).toBe('function');
	if (typeof build !== 'function') return;
	expect(build({ url: 'https://alice.example/home', referrer: 'https://app.example' })).toEqual({
		url: 'https://alice.example/home',
		referrer: '',
	});
});

test('the before-send hook sends the route pattern in place of the address and the title', async () => {
	await installed();

	const sent = beforeSend('event', {
		website: 'w',
		hostname: 'alice.app.example',
		url: 'https://alice.app.example/projects/acme/tasks/ACME-12?file=plan.md#top',
		title: 'ACME-12 Fix the login page',
		referrer: 'https://app.example/dashboard?code=secret',
		name: 'create-task',
	});

	expect(sent).toEqual({
		website: 'w',
		hostname: 'alice.app.example',
		url: PATTERN,
		title: PATTERN,
		referrer: 'https://app.example',
		name: 'create-task',
	});
});

test('the before-send hook asks for the page at the moment of the send', async () => {
	await installed();

	page = '/home';
	expect(beforeSend('event', { url: 'x' })).toMatchObject({ url: '/home', title: '/home' });
	page = '/settings/api-keys?tab=new#key';
	expect(beforeSend('event', { url: 'x' })).toMatchObject({ url: '/settings/api-keys' });
	page = 'settings';
	expect(beforeSend('event', { url: 'x' })).toMatchObject({ url: '/settings' });
});

test.each<[string, unknown]>([
	['a same-site path, as the tracker reports one', '/projects/acme/tasks/ACME-12'],
	['a same-site address', `${window.location.origin}/projects/acme`],
	['no referrer', ''],
	['a missing referrer', undefined],
	['a referrer that is not a web address', 'android-app://com.example/'],
])('the before-send hook sends no referrer for %s', async (_label, referrer) => {
	await installed();
	expect(beforeSend('event', { url: 'x', referrer })).toMatchObject({ referrer: '' });
});

test('a page that cannot be named is not sent at all', async () => {
	analytics.installAnalytics({
		...options(),
		pagePattern: () => {
			throw new Error('no router yet');
		},
	});
	hookName = tracker().getAttribute('data-before-send');
	expect(beforeSend('event', { url: 'https://alice.app.example/projects/acme' })).toBe(false);
});

test('counts a click on a marked element by its name, and never its text', async () => {
	await installed();
	analytics.installAnalyticsClicks();
	analytics.installAnalyticsClicks();
	track.mockClear();

	document.body.innerHTML = `
		<a href="#somewhere" data-analytics="create-task"><span id="inner">Create <b>ACME-12</b></span></a>
		<button id="plain">Plain</button>
		<div data-analytics="Not a Name"><button id="bad">Bad</button></div>
		<div data-analytics="${'x'.repeat(51)}"><button id="long">Long</button></div>`;

	const link = document.querySelector('a') as HTMLAnchorElement;
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	(document.getElementById('inner') as HTMLElement).dispatchEvent(click);
	expect(track.mock.calls).toEqual([['create-task']]);
	// Counting a click never takes it over: the link still goes where it goes.
	expect(click.defaultPrevented).toBe(false);
	expect(link.getAttribute('href')).toBe('#somewhere');

	clickOn(document.getElementById('plain') as HTMLElement);
	clickOn(document.getElementById('bad') as HTMLElement);
	clickOn(document.getElementById('long') as HTMLElement);
	expect(track).toHaveBeenCalledTimes(1);
});

test('a click counts even where a handler stops it from bubbling', async () => {
	await installed();
	analytics.installAnalyticsClicks();
	track.mockClear();

	document.body.innerHTML = '<button data-analytics="approve-request">Approve</button>';
	const button = document.querySelector('button') as HTMLButtonElement;
	button.addEventListener('click', (event) => event.stopPropagation());
	clickOn(button);
	expect(track.mock.calls).toEqual([['approve-request']]);
});

test('masks page text before the recorder loads, and loads it once', async () => {
	await installed();
	const masked: boolean[] = [];
	const append = document.head.appendChild.bind(document.head);
	vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
		masked.push(document.documentElement.classList.contains('rr-mask'));
		return append(node);
	});

	analytics.startSessionRecording({ showText: false });
	analytics.startSessionRecording({ showText: true });

	const recorders = scriptAt('https://stats.example/hz/recorder.js');
	expect(recorders).toHaveLength(1);
	expect(recorders[0].getAttribute('data-website-id')).toBe('2d1f3c4b-5a69-4f7e-8d9c-0b1a2c3d4e5f');
	expect(recorders[0].defer).toBe(true);
	// The mask was in place when the recorder was added, so its first snapshot
	// never held the page's text.
	expect(masked).toEqual([true]);
	expect(document.documentElement.classList.contains('rr-mask')).toBe(true);
});

test('shows page text only when asked to', async () => {
	await installed();
	analytics.startSessionRecording({ showText: true });

	expect(scriptAt('https://stats.example/hz/recorder.js')).toHaveLength(1);
	expect(document.documentElement.classList.contains('rr-mask')).toBe(false);
});

test('records nothing before the tracker is installed', () => {
	analytics.startSessionRecording({ showText: false });

	expect(scriptAt('https://stats.example/hz/recorder.js')).toHaveLength(0);
	expect(document.documentElement.classList.contains('rr-mask')).toBe(false);
});

test('a rate of 0 never records and a rate of 1 always does, whatever was kept', () => {
	sessionStorage.setItem('hezo:analytics:record-visit', '1');
	expect(analytics.shouldRecordThisVisit(0)).toBe(false);
	expect(analytics.shouldRecordThisVisit(Number.NaN)).toBe(false);

	sessionStorage.setItem('hezo:analytics:record-visit', '0');
	expect(analytics.shouldRecordThisVisit(1)).toBe(true);
});

test('decides once per browser session and keeps the decision', () => {
	const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
	expect(analytics.shouldRecordThisVisit(0.5)).toBe(true);
	random.mockReturnValue(0.9);
	expect(analytics.shouldRecordThisVisit(0.5)).toBe(true);

	// A new browser session decides again, and keeps that.
	sessionStorage.clear();
	expect(analytics.shouldRecordThisVisit(0.5)).toBe(false);
	random.mockReturnValue(0.1);
	expect(analytics.shouldRecordThisVisit(0.5)).toBe(false);
});

test('decides without throwing where storage is blocked', () => {
	vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
		throw new Error('SecurityError');
	});
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('SecurityError');
	});
	vi.spyOn(Math, 'random').mockReturnValue(0.1);

	expect(analytics.shouldRecordThisVisit(0.5)).toBe(true);
});

test('never throws, whether the tracker is absent or failing', async () => {
	// Before install, with nothing on the page.
	expect(() => {
		analytics.trackAnalyticsPageView();
		analytics.trackAnalyticsEvent('create-task');
		analytics.startSessionRecording({ showText: false });
	}).not.toThrow();

	// A tracker that throws, and one that rejects.
	track.mockImplementationOnce(() => {
		throw new Error('tracker fault');
	});
	await installed();
	track.mockImplementation(() => Promise.reject(new Error('network')));
	analytics.installAnalyticsClicks();
	document.body.innerHTML = '<button data-analytics="send-chat-message">Send</button>';
	expect(() => {
		analytics.trackAnalyticsPageView();
		analytics.trackAnalyticsEvent('create-task');
		clickOn(document.querySelector('button') as HTMLButtonElement);
	}).not.toThrow();
});

test('a tracker that loads without defining its API leaves the page alone', async () => {
	delete testWindow.umami;
	analytics.installAnalytics(options());
	hookName = tracker().getAttribute('data-before-send');
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(() => {
		analytics.trackAnalyticsPageView();
		analytics.trackAnalyticsEvent('create-task');
	}).not.toThrow();
	expect(track).not.toHaveBeenCalled();
});

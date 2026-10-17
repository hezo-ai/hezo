/**
 * Product analytics and session recording through a self-hosted Umami, loaded
 * once per page for one signed-in person.
 *
 * **Framework-neutral on purpose**, like the support chat loader: plain
 * functions over module state rather than a hook or a provider, so any Hezo
 * site can call them from wherever it decides a person is signed in.
 *
 * **Every call is safe at any moment.** The scripts load from another origin
 * and define their API some time after install, a blocked load never defines
 * it, and a call made in between waits in a short queue. Nothing here throws:
 * analytics that fail stay out of the page that hosts them.
 *
 * **What the tracker sends is decided here.** Every payload passes through the
 * before-send hook installed with the tracker, which replaces the page's real
 * address and title with the route pattern the consumer names
 * (`/projects/$projectId/tasks/$taskId`, never the project or the task) and cuts
 * the referrer to an origin. A page that cannot be named is not sent at all. The
 * recorder is not the tracker and has no such hook: it reads `location.href`
 * itself for its page markers and heatmap events.
 *
 * **Page views are the consumer's to report.** The tracker's own history hook is
 * off (`data-auto-track="false"`): it watches `pushState` and `replaceState` but
 * not back and forward, so leaving it on beside a router subscription counts
 * some navigations twice and others not at all. The consumer calls
 * `trackAnalyticsPageView` once per route change, every kind included;
 * `installAnalytics` reports the page the visit starts on.
 *
 * **Recording sees no page text unless asked to show it.** `rr-mask` on `<html>`
 * hides every text node under it from the recorder, and a component carrying
 * `NEVER_RECORD_CLASS` is replaced by a blank box of the same size. Typed input
 * is hidden by the Umami website's own mask level, which this module does not set.
 */

import { readSessionStored, writeSessionStored } from './safe-storage.js';

/**
 * The class a component carries to be left out of every recording: the
 * recorder replaces the element and everything under it, its attributes
 * included, with a blank box of the same size. Put it on the component that
 * renders the secret, not at a call site, so every screen that reuses it is
 * covered.
 */
export const NEVER_RECORD_CLASS = 'rr-block';

/** The class that hides every text node under an element from the recorder. */
export const MASK_TEXT_CLASS = 'rr-mask';

/**
 * The attribute naming a click worth counting, as `data-analytics="create-task"`.
 * The name is sent; the element's text never is.
 */
export const ANALYTICS_ATTRIBUTE = 'data-analytics';

/** The global the tracker calls before every send, named on its script tag. */
const BEFORE_SEND_HOOK = 'hezoAnalyticsBeforeSend';

/** Where this browser session's recording decision is kept. */
const RECORD_VISIT_KEY = 'hezo:analytics:record-visit';

/**
 * Calls made before the tracker loaded. Bounded because a blocked script never
 * loads, and a page left open must not grow a list nobody will drain.
 */
const MAX_QUEUED_CALLS = 50;

/** Kebab-case, within Umami's 50-character limit on an event name. */
const EVENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_EVENT_NAME_LENGTH = 50;

export interface AnalyticsOptions {
	/** Where `script.js` and `recorder.js` are served, with no trailing slash. */
	host: string;
	/** The Umami website the visits are counted under. */
	websiteId: string;
	/** Who the visitor is to that website: an account id, never an email. */
	distinctId: string;
	/**
	 * The current page's route pattern, as `/projects/$projectId/tasks/$taskId`.
	 * Asked at the moment of every send, so it must describe the page the person
	 * is on then; anything after a `?` or `#` is cut.
	 */
	pagePattern: () => string;
}

export interface SessionRecordingOptions {
	/**
	 * Record page text as shown. False hides it all. Typed input is the Umami
	 * website's mask level to hide, whichever this is.
	 */
	showText: boolean;
}

/** A tracker payload, as far as this module reads or rewrites it. */
interface TrackerPayload {
	url?: string;
	title?: string;
	referrer?: string;
	[field: string]: unknown;
}

/** The part of the tracker's runtime API this module calls. */
interface UmamiTracker {
	track(event?: string | ((payload: TrackerPayload) => TrackerPayload)): unknown;
}

type BeforeSend = (type: string, payload: TrackerPayload) => TrackerPayload | false;

interface AnalyticsHost {
	umami?: UmamiTracker;
	[BEFORE_SEND_HOOK]?: BeforeSend;
}

type TrackerCall = (umami: UmamiTracker) => unknown;

interface AnalyticsState {
	host: string;
	websiteId: string;
	pagePattern: () => string;
	/** True once the tracker script has run; calls go straight to it from then on. */
	loaded: boolean;
	queue: TrackerCall[];
	pageViews: number;
	recording: boolean;
}

let state: AnalyticsState | null = null;
let clicksInstalled = false;

function host(): Window & AnalyticsHost {
	return window;
}

/** Call the tracker if it exists, and absorb anything it throws or rejects with. */
function dispatch(call: TrackerCall): void {
	const umami = host().umami;
	if (!umami) return;
	try {
		Promise.resolve(call(umami)).catch(() => {});
	} catch {
		// A fault in the tracker is not a fault in the page that hosts it.
	}
}

function enqueue(call: TrackerCall): void {
	if (!state) return;
	if (state.loaded) dispatch(call);
	else if (state.queue.length < MAX_QUEUED_CALLS) state.queue.push(call);
}

function onTrackerLoad(): void {
	if (!state) return;
	state.loaded = true;
	for (const call of state.queue.splice(0)) dispatch(call);
}

/** A route pattern as a path: nothing after `?` or `#`, and a leading slash. */
function asPattern(value: string): string {
	const path = String(value).split(/[?#]/, 1)[0] ?? '';
	return path.startsWith('/') ? path : `/${path}`;
}

/**
 * The referrer's origin when it is another site, and nothing when it is this
 * one: the tracker reports a same-site referrer as the previous page's real path.
 */
function referrerOrigin(referrer: unknown): string {
	if (typeof referrer !== 'string' || referrer === '') return '';
	try {
		const url = new URL(referrer, window.location.href);
		if (url.origin === window.location.origin) return '';
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
	} catch {
		return '';
	}
}

/** The hook the tracker runs on every payload before it leaves the browser. */
function beforeSend(_type: string, payload: TrackerPayload): TrackerPayload | false {
	if (!state) return false;
	try {
		const page = asPattern(state.pagePattern());
		return { ...payload, url: page, title: page, referrer: referrerOrigin(payload.referrer) };
	} catch {
		// A page that cannot be named is not sent under its real address instead.
		return false;
	}
}

/**
 * Load the tracker, identified as one visitor, and report the page the visit
 * starts on. Loads once per page; a later call does nothing.
 */
export function installAnalytics(options: AnalyticsOptions): void {
	if (typeof window === 'undefined' || typeof document === 'undefined' || state) return;
	try {
		const base = options.host.replace(/\/+$/, '');
		state = {
			host: base,
			websiteId: options.websiteId,
			pagePattern: options.pagePattern,
			loaded: false,
			queue: [],
			pageViews: 0,
			recording: false,
		};
		host()[BEFORE_SEND_HOOK] = beforeSend;

		const script = document.createElement('script');
		script.src = `${base}/script.js`;
		script.defer = true;
		// An inserted script runs whenever it arrives unless told otherwise; this
		// keeps the tracker ahead of the recorder, which reads the tracker's session.
		script.async = false;
		script.setAttribute('data-website-id', options.websiteId);
		// On the tag rather than through `identify()`, which in this tracker starts
		// a new session and splits a recording in two.
		script.setAttribute('data-distinct-id', options.distinctId);
		script.setAttribute('data-before-send', BEFORE_SEND_HOOK);
		script.setAttribute('data-auto-track', 'false');
		script.addEventListener('load', onTrackerLoad);
		document.head.appendChild(script);

		trackAnalyticsPageView();
	} catch {
		// As in `dispatch`: analytics failing to start leaves the page alone.
	}
}

/**
 * Report a page view for the page the person is on now. Call it once per route
 * change, back and forward included. Does nothing before install.
 */
export function trackAnalyticsPageView(): void {
	if (!state) return;
	const first = state.pageViews === 0;
	state.pageViews += 1;
	// Only the page a visit starts on has a referrer worth naming. The tracker
	// keeps offering the one the page loaded with, so later views drop it.
	enqueue((umami) =>
		first ? umami.track() : umami.track((payload) => ({ ...payload, referrer: '' })),
	);
}

/**
 * Report a named event, such as `create-task`. A name that is not kebab-case,
 * or is longer than 50 characters, is dropped rather than sent: a name is a
 * fixed label, and one built from page content would carry that content out.
 * Does nothing before install.
 */
export function trackAnalyticsEvent(name: string): void {
	if (!state || name.length > MAX_EVENT_NAME_LENGTH || !EVENT_NAME.test(name)) return;
	enqueue((umami) => umami.track(name));
}

function onClick(event: Event): void {
	try {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const name = target.closest(`[${ANALYTICS_ATTRIBUTE}]`)?.getAttribute(ANALYTICS_ATTRIBUTE);
		if (name) trackAnalyticsEvent(name);
	} catch {
		// A click is never worth an error in the page.
	}
}

/**
 * Count every click on an element carrying `data-analytics`, or inside one, as
 * the event it names. One listener for the page, on the capture phase so a
 * handler that stops propagation still counts. Installs once; never prevents
 * the click or changes where it goes.
 */
export function installAnalyticsClicks(): void {
	if (typeof document === 'undefined' || clicksInstalled) return;
	try {
		document.addEventListener('click', onClick, true);
		clicksInstalled = true;
	} catch {
		// As in `dispatch`.
	}
}

/**
 * Whether this browser session is recorded, at `sampleRate` from 0 to 1.
 *
 * Decided once per browser session and kept in `sessionStorage`, so a visit is
 * recorded whole or not at all rather than page by page. 0 is never and 1 is
 * always, whatever an earlier page decided. Where storage is unavailable the
 * decision is made afresh on each load.
 */
export function shouldRecordThisVisit(sampleRate: number): boolean {
	if (!(sampleRate > 0)) return false;
	if (sampleRate >= 1) return true;
	const kept = readSessionStored(RECORD_VISIT_KEY);
	if (kept === '1') return true;
	if (kept === '0') return false;
	const record = Math.random() < sampleRate;
	writeSessionStored(RECORD_VISIT_KEY, record ? '1' : '0');
	return record;
}

/**
 * Start recording this page, through the recorder served beside the tracker.
 * Hides all page text first unless `showText` is set. Starts once per page, and
 * does nothing before `installAnalytics`, whose host and website it uses.
 */
export function startSessionRecording(options: SessionRecordingOptions): void {
	if (!state || state.recording) return;
	try {
		state.recording = true;
		// Before the recorder loads, so its first snapshot is already masked.
		if (!options.showText) document.documentElement.classList.add(MASK_TEXT_CLASS);

		const script = document.createElement('script');
		script.src = `${state.host}/recorder.js`;
		script.defer = true;
		script.async = false;
		script.setAttribute('data-website-id', state.websiteId);
		document.head.appendChild(script);
	} catch {
		// As in `dispatch`.
	}
}

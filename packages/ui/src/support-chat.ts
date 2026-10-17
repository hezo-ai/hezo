/**
 * A Chatwoot support chat, loaded once per page and identified as one person.
 *
 * **Framework-neutral on purpose.** Plain functions over module state rather
 * than a hook or a provider, so any Hezo site can call them from wherever it
 * decides a person is signed in, and the chat outlives any component that
 * mounted it.
 *
 * **Every call is safe at any moment.** The widget script loads from another
 * origin and defines its API some time after install, a blocked or failed load
 * never defines it, and its methods throw on input they dislike. Nothing here
 * throws for any of those reasons: a support widget that fails stays inside
 * the widget.
 *
 * **Its cookies stay on this host.** The settings never name a cookie domain,
 * so the widget keeps its conversation cookie on the exact host that loaded it
 * rather than sharing it with sibling subdomains.
 *
 * **Where the person is reaches the inbox only while the chat is open.** The
 * page hands over its context whenever it changes; the module sends it when the
 * panel opens, again on every change while it stays open, and again when a
 * conversation starts. Somebody who chatted once is not reported on every page
 * they visit afterwards.
 */

import { pinnedScript } from './pinned-script.js';

export type SupportChatColorScheme = 'light' | 'dark' | 'auto';

export interface SupportChatIdentity {
	/** The contact identifier in the inbox. */
	identifier: string;
	/** The inbox's HMAC of `identifier`, computed server-side by whoever holds the inbox secret. */
	identifierHash: string;
	/** At least one of `name` and `email` must be set, or the widget cannot identify the person. */
	name?: string;
	email?: string;
}

export interface SupportChatOptions {
	/** The Chatwoot installation's origin. */
	baseUrl: string;
	/** The website inbox's public token. */
	websiteToken: string;
	/** The Subresource Integrity value the widget script must match. */
	sdkIntegrity: string;
	/**
	 * Who to tell the inbox the visitor is, where anybody knows.
	 *
	 * Absent on a page reached before signing in: there is nobody to name, and a
	 * name nobody signed is one anybody could claim. The widget loads and the
	 * conversation is a stranger's until an install carrying an identity adopts
	 * it, which is what signing in on the same page does.
	 */
	identity?: SupportChatIdentity;
	/** A BCP 47 language tag, such as `en`, `pt-BR` or `zh-Hans`. */
	locale: string;
	colorScheme: SupportChatColorScheme;
	/** Hide the launcher bubble, for a page that opens the chat from its own control. */
	hideBubble: boolean;
}

/** The part of the widget's runtime API this module calls. */
interface ChatwootApi {
	setUser(
		identifier: string,
		user: { name?: string; email?: string; identifier_hash: string },
	): void;
	toggle(state: 'open' | 'close'): void;
	setLocale(locale: string): void;
	setColorScheme(scheme: SupportChatColorScheme): void;
	toggleBubbleVisibility(state: 'hide' | 'show'): void;
	setConversationCustomAttributes(attributes: Record<string, string>): void;
	reset(): void;
}

interface ChatwootHost {
	chatwootSettings?: {
		locale: string;
		darkMode: SupportChatColorScheme;
		hideMessageBubble: boolean;
	};
	chatwootSDK?: { run(config: { websiteToken: string; baseUrl: string }): void };
	$chatwoot?: ChatwootApi;
}

interface SupportChatState {
	/** Null once reset, so a reload of the widget does not identify the previous person again. */
	identity: SupportChatIdentity | null;
	locale: string;
	colorScheme: SupportChatColorScheme;
	/** True once the widget has reported ready; its API stays usable across a reset. */
	ready: boolean;
	/** A request to open that arrived before the widget could act on it. */
	openWhenReady: boolean;
	/** Whether the chat panel is open, which is the only time the context is sent. */
	open: boolean;
	/** Where the page says the person is, as it will be sent. */
	context: Record<string, string> | null;
	/** The context last sent, serialised, so an unchanged one is not sent again. */
	sent: string | null;
}

let state: SupportChatState | null = null;

function host(): Window & ChatwootHost {
	return window;
}

/** Call the widget if it exists, and absorb anything it throws. True when the call went through. */
function withChatwoot(action: (chatwoot: ChatwootApi) => void): boolean {
	const chatwoot = host().$chatwoot;
	if (!chatwoot) return false;
	try {
		action(chatwoot);
		return true;
	} catch {
		// A fault in the widget is not a fault in the page that hosts it.
		return false;
	}
}

/** Region stand-ins for the script subtags the widget's locale codes do not use. */
const SCRIPT_REGIONS: Record<string, string> = { hans: 'CN', hant: 'TW' };

/** A BCP 47 tag in the widget's form: `pt-BR` to `pt_BR`, `zh-Hans` to `zh_CN`. */
function toChatwootLocale(tag: string): string {
	const [language, subtag] = tag.split(/[-_]/);
	if (!subtag) return language.toLowerCase();
	const region = SCRIPT_REGIONS[subtag.toLowerCase()] ?? subtag.toUpperCase();
	return `${language.toLowerCase()}_${region}`;
}

/** One spelling per context, whatever order the page built it in. */
function serialise(context: Record<string, string>): string {
	return JSON.stringify(
		Object.keys(context)
			.sort()
			.map((key) => [key, context[key]]),
	);
}

/**
 * Send the context, if the panel is open and it changed since the last send.
 *
 * **Always the whole object.** Once a conversation exists, the inbox replaces
 * the conversation's attributes with what it is sent rather than merging, so a
 * partial update would erase every key it left out. A fact the page does not
 * have travels as an empty string, which clears whatever an earlier page said.
 * An empty object is never sent: the widget throws on one.
 */
function sendContext(): void {
	if (!state?.ready || !state.open || !state.context) return;
	const context = state.context;
	if (Object.keys(context).length === 0) return;
	const serialised = serialise(context);
	if (serialised === state.sent) return;
	// Recorded only once the widget took it, so a send it refused is tried
	// again on the next open or change rather than skipped as done.
	if (withChatwoot((chatwoot) => chatwoot.setConversationCustomAttributes({ ...context }))) {
		state.sent = serialised;
	}
}

function onOpened(): void {
	if (!state) return;
	state.open = true;
	sendContext();
}

function onClosed(): void {
	if (state) state.open = false;
}

/**
 * A new conversation starts with no attributes. The widget keeps what it was
 * sent before the first message only until that message goes, so a second
 * conversation after the first is resolved would otherwise start empty.
 *
 * **Only the panel's own events say it is open.** This one arrives after the
 * first message is answered, by which time the person may have closed the
 * panel; the context then goes when they next open it.
 */
function onConversationStarted(): void {
	if (!state) return;
	state.sent = null;
	sendContext();
}

function identify(identity: SupportChatIdentity): void {
	withChatwoot((chatwoot) =>
		chatwoot.setUser(identity.identifier, {
			...(identity.name ? { name: identity.name } : {}),
			...(identity.email ? { email: identity.email } : {}),
			identifier_hash: identity.identifierHash,
		}),
	);
}

/**
 * Apply everything that waited for the widget: the identity, then any locale or
 * scheme change made while it loaded, then an early request to open.
 */
function onReady(): void {
	if (!state) return;
	state.ready = true;
	const { identity, locale, colorScheme } = state;
	if (identity) identify(identity);
	withChatwoot((chatwoot) => {
		chatwoot.setLocale(locale);
		chatwoot.setColorScheme(colorScheme);
	});
	if (state.openWhenReady) {
		state.openWhenReady = false;
		withChatwoot((chatwoot) => chatwoot.toggle('open'));
	}
}

/**
 * Load the widget, and identify the person where there is one to identify.
 *
 * Loads once per page. A later call adds nothing to the page; it hands over an
 * identity the page did not have before — after a reset, or after signing in on
 * a page that opened the chat anonymously — so the next person on that page is
 * identified as themselves.
 */
export function installSupportChat(options: SupportChatOptions): void {
	if (typeof window === 'undefined') return;

	if (state) {
		// **The anonymous install is the one this adopts.** A page that loaded the
		// widget with nobody named — a sign-in form, a gate — hands the identity
		// over the moment it has one, and the conversation already open becomes
		// that person's rather than being abandoned beside a second one.
		if (!state.identity && options.identity) {
			state.identity = options.identity;
			if (state.ready) identify(options.identity);
		}
		return;
	}

	const baseUrl = options.baseUrl.replace(/\/+$/, '');
	const locale = toChatwootLocale(options.locale);
	state = {
		identity: options.identity ?? null,
		locale,
		colorScheme: options.colorScheme,
		ready: false,
		openWhenReady: false,
		open: false,
		context: null,
		sent: null,
	};

	host().chatwootSettings = {
		locale,
		darkMode: options.colorScheme,
		hideMessageBubble: options.hideBubble,
	};
	window.addEventListener('chatwoot:ready', onReady);
	window.addEventListener('chatwoot:opened', onOpened);
	window.addEventListener('chatwoot:closed', onClosed);
	window.addEventListener('chatwoot:on-start-conversation', onConversationStarted);

	const script = pinnedScript(`${baseUrl}/packs/js/sdk.js`, options.sdkIntegrity);
	script.async = true;
	script.addEventListener('load', () => {
		try {
			host().chatwootSDK?.run({ websiteToken: options.websiteToken, baseUrl });
		} catch {
			// As in `withChatwoot`: the widget failing to start leaves the page alone.
		}
	});
	document.head.appendChild(script);
}

/**
 * Show or hide the launcher bubble after the widget is loaded.
 *
 * `hideBubble` decides this at install, and installing happens once per page —
 * but whether the corner is free can change without a reload. Signing in draws
 * a shell that claims it, and the chat moves to that shell's own menu entry.
 * Does nothing before install.
 */
export function setSupportChatBubble(visible: boolean): void {
	if (!state) return;
	withChatwoot((chatwoot) => chatwoot.toggleBubbleVisibility(visible ? 'show' : 'hide'));
}

/** Open the chat, now or as soon as the widget is ready. Does nothing before install. */
export function openSupportChat(): void {
	if (!state) return;
	if (state.ready) withChatwoot((chatwoot) => chatwoot.toggle('open'));
	else state.openWhenReady = true;
}

/**
 * Forget the person signed in: the widget drops its conversation and reloads
 * anonymous. Call it on sign-out, before the page leaves.
 */
export function resetSupportChat(): void {
	if (!state) return;
	state.identity = null;
	state.openWhenReady = false;
	// The widget reloads with no conversation, so the next one is sent the
	// context afresh when the panel opens on it.
	state.open = false;
	state.sent = null;
	withChatwoot((chatwoot) => chatwoot.reset());
}

/** Follow the page's colour scheme. */
export function setSupportChatTheme(scheme: SupportChatColorScheme): void {
	if (!state || state.colorScheme === scheme) return;
	state.colorScheme = scheme;
	if (state.ready) withChatwoot((chatwoot) => chatwoot.setColorScheme(scheme));
}

/** Follow the page's language, given as a BCP 47 tag. */
export function setSupportChatLocale(locale: string): void {
	if (!state) return;
	const code = toChatwootLocale(locale);
	if (state.locale === code) return;
	state.locale = code;
	if (state.ready) withChatwoot((chatwoot) => chatwoot.setLocale(code));
}

/**
 * Say where the person is: the conversation attributes the inbox shows beside
 * the chat. Pass the page's whole context every time, with `null` for a fact it
 * does not have; the module sends it when the panel opens and whenever it
 * changes while open. Does nothing before install.
 */
export function setSupportChatContext(context: Readonly<Record<string, string | null>>): void {
	if (!state) return;
	state.context = Object.fromEntries(
		Object.entries(context).map(([key, value]) => [key, value ?? '']),
	);
	sendContext();
}

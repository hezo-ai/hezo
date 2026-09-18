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
 */

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
	identity: SupportChatIdentity;
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
}

let state: SupportChatState | null = null;

function host(): Window & ChatwootHost {
	return window;
}

/** Call the widget if it exists, and absorb anything it throws. */
function withChatwoot(action: (chatwoot: ChatwootApi) => void): void {
	const chatwoot = host().$chatwoot;
	if (!chatwoot) return;
	try {
		action(chatwoot);
	} catch {
		// A fault in the widget is not a fault in the page that hosts it.
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
 * Load the widget and identify the person signed in.
 *
 * Loads once per page. A later call adds nothing to the page; after a reset it
 * adopts the identity it is given, so the next person signed in on the same page
 * is identified as themselves.
 */
export function installSupportChat(options: SupportChatOptions): void {
	if (typeof window === 'undefined') return;

	if (state) {
		if (!state.identity) {
			state.identity = options.identity;
			if (state.ready) identify(options.identity);
		}
		return;
	}

	const baseUrl = options.baseUrl.replace(/\/+$/, '');
	const locale = toChatwootLocale(options.locale);
	state = {
		identity: options.identity,
		locale,
		colorScheme: options.colorScheme,
		ready: false,
		openWhenReady: false,
	};

	host().chatwootSettings = {
		locale,
		darkMode: options.colorScheme,
		hideMessageBubble: options.hideBubble,
	};
	window.addEventListener('chatwoot:ready', onReady);

	const script = document.createElement('script');
	script.src = `${baseUrl}/packs/js/sdk.js`;
	script.integrity = options.sdkIntegrity;
	// Integrity is checked only on a CORS response, and an anonymous request
	// sends no credentials to the other origin.
	script.crossOrigin = 'anonymous';
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

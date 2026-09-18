import { runtimeConfig } from '../config/runtime';

/**
 * Where the support chat is, for a screen nobody has signed in to yet.
 *
 * On the public status payload for the reason the locale is: the master-key
 * gate, the language step and the sign-in form all render before any credential
 * exists, and somebody held up on one of them is exactly who needs to ask why.
 *
 * **The three public values and no more.** Every page that carries the widget
 * publishes these in its own markup. The identifier and its signature say who
 * the owner is and let whoever holds them write as the owner — and an instance
 * answers to anyone who knows its address, including one still being set up. The
 * owner's own session reads those from `GET /api/support` instead.
 *
 * **An issuer is required as well as a block**, the way the sign-in hint beside
 * it is. The chat belongs to the deployer who signs people in; an instance that
 * has no issuer has nobody on the other side of it, and the owner's own
 * `/api/support` answers 404 there for the same reason.
 *
 * Absent entirely when either is missing, so an ordinary instance's payload is
 * unchanged and nothing downstream has to know the field could exist.
 */
export function supportStatus(): {
	support?: { base_url: string; website_token: string; sdk_integrity: string };
} {
	const config = runtimeConfig();
	const chatwoot = config.policy?.support?.chatwoot;
	if (!chatwoot || !config.sso) return {};

	return {
		support: {
			base_url: chatwoot.baseUrl,
			website_token: chatwoot.websiteToken,
			sdk_integrity: chatwoot.sdkIntegrity,
		},
	};
}

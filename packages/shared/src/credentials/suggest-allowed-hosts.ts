/**
 * Best-effort inference of the `allowed_hosts` allowlist for a credential
 * request, so the human fulfilling it doesn't have to hand-type the API
 * host(s) the egress proxy should scope the secret to.
 *
 * Two complementary signals are combined:
 *
 *  1. **The request text** — any `https://host/…` URL the requesting agent put
 *     in its instructions is a concrete, request-specific hint (e.g. a
 *     self-hosted instance URL like `https://umami.acme.io`, which no static
 *     table could know). URL hosts win, since they describe *this* request.
 *  2. **Web knowledge of well-known services** — a curated map (plus the
 *     connector registry) of common SaaS API hosts, keyed by a token that
 *     typically appears in the credential's name or instructions
 *     (`NETLIFY_AUTH_TOKEN` → `api.netlify.com`).
 *
 * The result is only a *suggestion*: the human always reviews and can edit or
 * clear it before the secret is stored. It is therefore intentionally generous
 * (a wrong suggestion costs one edit) rather than conservative.
 */

import { CONNECTOR_CAPABILITIES } from '../types/connector-capabilities.js';

export interface SuggestAllowedHostsInput {
	/** The credential name, e.g. `NETLIFY_AUTH_TOKEN`. */
	name?: string;
	/** The human-facing instructions the agent attached to the request. */
	instructions?: string;
}

/**
 * Curated API hosts for well-known services, keyed by a lowercase token that
 * commonly shows up in a credential name or its instructions. This is the
 * "web knowledge of the service" layer. Kept intentionally focused on common
 * providers — the URL-extraction signal covers the long tail (anything whose
 * endpoint the agent names explicitly), and the human reviews the result.
 */
const KNOWN_SERVICE_HOSTS: Record<string, string[]> = {
	netlify: ['api.netlify.com'],
	vercel: ['api.vercel.com'],
	stripe: ['api.stripe.com'],
	openai: ['api.openai.com'],
	anthropic: ['api.anthropic.com'],
	openrouter: ['openrouter.ai'],
	deepseek: ['api.deepseek.com'],
	groq: ['api.groq.com'],
	cohere: ['api.cohere.com'],
	huggingface: ['huggingface.co', 'api-inference.huggingface.co'],
	sendgrid: ['api.sendgrid.com'],
	mailgun: ['api.mailgun.net'],
	postmark: ['api.postmarkapp.com'],
	resend: ['api.resend.com'],
	twilio: ['api.twilio.com'],
	slack: ['slack.com'],
	discord: ['discord.com'],
	github: ['api.github.com'],
	gitlab: ['gitlab.com'],
	linear: ['api.linear.app'],
	notion: ['api.notion.com'],
	airtable: ['api.airtable.com'],
	hubspot: ['api.hubapi.com'],
	shopify: ['*.myshopify.com'],
	supabase: ['*.supabase.co'],
	cloudflare: ['api.cloudflare.com'],
	digitalocean: ['api.digitalocean.com'],
	datadog: ['api.datadoghq.com'],
	sentry: ['sentry.io'],
	pagerduty: ['api.pagerduty.com'],
	mixpanel: ['api.mixpanel.com'],
	amplitude: ['api.amplitude.com'],
	posthog: ['app.posthog.com'],
	algolia: ['*.algolia.net'],
	pinecone: ['*.pinecone.io'],
	contentful: ['api.contentful.com'],
	datocms: ['site-api.datocms.com'],
	sanity: ['api.sanity.io'],
};

/**
 * Hosts that are never a useful API allowlist entry — placeholders and
 * loopback addresses an agent might paste as an example.
 */
const GENERIC_HOSTS = new Set([
	'example.com',
	'example.org',
	'example.net',
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
]);

const MAX_SUGGESTIONS = 6;

/** Pull the host portion out of every `http(s)://…` URL in a block of text. */
function extractUrlHosts(text: string): string[] {
	const hosts: string[] = [];
	const re = /https?:\/\/([^\s/:?#"'`)]+)/gi;
	let match: RegExpExecArray | null = re.exec(text);
	while (match !== null) {
		const host = match[1].toLowerCase();
		if (host.includes('.')) hosts.push(host);
		match = re.exec(text);
	}
	return hosts;
}

/** Lowercase alphanumeric tokens of a string (split on every non-alphanumeric run). */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

/**
 * Suggest an `allowed_hosts` allowlist for a credential request from its name
 * and instructions. Returns a de-duplicated, ordered list (URL-derived hosts
 * first, then known-service hosts), or an empty array when nothing matches.
 */
export function suggestAllowedHosts(input: SuggestAllowedHostsInput): string[] {
	const name = input.name ?? '';
	const instructions = input.instructions ?? '';

	const ordered: string[] = [];
	const seen = new Set<string>();
	const add = (host: string) => {
		const h = host.trim().toLowerCase();
		if (h.length === 0 || GENERIC_HOSTS.has(h) || seen.has(h)) return;
		seen.add(h);
		ordered.push(h);
	};

	// 1. Concrete hosts named in the instructions — most request-specific.
	for (const host of extractUrlHosts(instructions)) add(host);

	// 2. Known-service hosts: match name tokens first (the strongest signal),
	//    then instruction tokens.
	const nameTokens = new Set(tokenize(name));
	const instructionTokens = new Set(tokenize(instructions));
	for (const tokens of [nameTokens, instructionTokens]) {
		for (const [service, hosts] of Object.entries(KNOWN_SERVICE_HOSTS)) {
			if (tokens.has(service)) hosts.forEach(add);
		}
		// The connector registry is a second source of known hosts (its ids
		// match the same service tokens, e.g. `github`, `linear`, `vercel`).
		for (const [id, capability] of Object.entries(CONNECTOR_CAPABILITIES)) {
			if (tokens.has(id)) capability.allowedHosts.forEach(add);
		}
	}

	return ordered.slice(0, MAX_SUGGESTIONS);
}

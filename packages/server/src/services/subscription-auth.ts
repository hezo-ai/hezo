/**
 * Validates the credential blobs Hezo accepts for AI provider subscriptions.
 *
 * Each agent CLI authenticates against its vendor's subscription via a JSON
 * file the vendor's CLI writes during local login:
 *
 * - **Codex/ChatGPT (OpenAI)** — `~/.codex/auth.json` containing
 *   `{ tokens: { refresh_token, access_token, id_token } }`. The refresh token
 *   is single-use and rotates on every refresh; Hezo serialises runs against
 *   the same credential and persists the rotated value back.
 *
 * Anthropic (Claude Code) subscription is the exception: it is **not** a pasted
 * JSON file but a single long-lived OAuth token from `claude setup-token`,
 * delivered via the CLAUDE_CODE_OAUTH_TOKEN env var rather than a file mount.
 * {@link validateAnthropicOauthToken} validates the pasted token string.
 *
 * For the file-mount providers the user pastes the file contents and Hezo writes
 * them to a per-run mount inside the agent container.
 */

import { AiProvider } from '@hezo/shared';

export interface CodexAuthBlob {
	tokens: {
		id_token?: string;
		access_token?: string;
		refresh_token: string;
		account_id?: string;
		last_refresh?: string;
	};
	OPENAI_API_KEY?: string;
	[key: string]: unknown;
}

export interface SubscriptionValidation {
	ok: boolean;
	error?: string;
}

export function validateCodexAuthJson(raw: string): SubscriptionValidation {
	const parsed = parseJsonObject(raw, 'auth.json');
	if (!parsed.ok) return parsed;

	const tokens = parsed.value.tokens;
	if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
		return { ok: false, error: 'auth.json is missing the "tokens" object' };
	}

	const refresh = (tokens as Record<string, unknown>).refresh_token;
	if (typeof refresh !== 'string' || refresh.length === 0) {
		return {
			ok: false,
			error:
				'auth.json is missing tokens.refresh_token — log in again with `codex login` and re-copy the file',
		};
	}

	return { ok: true };
}

/**
 * Validates the Anthropic subscription credential — the long-lived OAuth token
 * printed by `claude setup-token` (format `sk-ant-oat01-…`). This is a bare
 * token string, not a JSON blob; it is injected via CLAUDE_CODE_OAUTH_TOKEN.
 */
export function validateAnthropicOauthToken(raw: string): SubscriptionValidation {
	const token = raw.trim();
	if (token.length === 0) {
		return { ok: false, error: 'Paste the token printed by `claude setup-token`' };
	}
	if (!token.startsWith('sk-ant-oat01-')) {
		return {
			ok: false,
			error:
				'That does not look like a Claude OAuth token — run `claude setup-token` and paste the `sk-ant-oat01-…` value it prints (not an API key)',
		};
	}
	return { ok: true };
}

/**
 * What each provider's subscription blob has to look like. A provider absent here
 * has no subscription path at all, which is why the map is partial rather than
 * total: most providers are api-key only, and that is an answer, not a gap.
 */
const SUBSCRIPTION_VALIDATORS: Partial<
	Record<AiProvider, (raw: string) => SubscriptionValidation>
> = {
	[AiProvider.Anthropic]: validateAnthropicOauthToken,
	[AiProvider.OpenAI]: validateCodexAuthJson,
};

export function validateSubscriptionBlob(
	provider: AiProvider,
	raw: string,
): SubscriptionValidation {
	const validate = SUBSCRIPTION_VALIDATORS[provider];
	if (!validate) return { ok: false, error: `${provider} does not support subscription auth` };
	return validate(raw);
}

interface ParsedObject {
	ok: true;
	value: Record<string, unknown>;
}
interface ParseFailure {
	ok: false;
	error: string;
}

function parseJsonObject(raw: string, fileLabel: string): ParsedObject | ParseFailure {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: `${fileLabel} contents are not valid JSON` };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: `${fileLabel} must be a JSON object` };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

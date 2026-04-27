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
 * - **Gemini (Google)** — `~/.gemini/oauth_creds.json` containing the standard
 *   Google `Credentials` shape `{ access_token, refresh_token, token_type,
 *   scope, expiry_date }`. The refresh token is stable and reusable, so no
 *   rotation persistence is needed; we materialise the file fresh per run.
 *
 * The user pastes the file contents and Hezo writes them to a per-run mount
 * inside the agent container.
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

export interface GeminiAuthBlob {
	access_token?: string;
	refresh_token: string;
	token_type?: string;
	scope?: string;
	expiry_date?: number;
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

export function validateGeminiAuthJson(raw: string): SubscriptionValidation {
	const parsed = parseJsonObject(raw, 'oauth_creds.json');
	if (!parsed.ok) return parsed;

	const refresh = parsed.value.refresh_token;
	if (typeof refresh !== 'string' || refresh.length === 0) {
		return {
			ok: false,
			error:
				'oauth_creds.json is missing refresh_token — sign in again with the Gemini CLI and re-copy the file',
		};
	}

	return { ok: true };
}

export function validateSubscriptionBlob(
	provider: AiProvider,
	raw: string,
): SubscriptionValidation {
	switch (provider) {
		case AiProvider.OpenAI:
			return validateCodexAuthJson(raw);
		case AiProvider.Google:
			return validateGeminiAuthJson(raw);
		default:
			return { ok: false, error: `${provider} does not support subscription auth` };
	}
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

/**
 * Helpers for handling Codex (OpenAI ChatGPT-subscription) credentials.
 *
 * Codex authenticates against ChatGPT subscriptions via a JSON blob normally
 * found at `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). The blob is
 * a single-use rotating refresh token wrapped in OIDC claims; codex reads it
 * directly, and there is no equivalent env var. Hezo stores the JSON exactly
 * as the user pastes it from their local `codex login` and materialises it
 * into a per-run `$CODEX_HOME` at agent run time.
 */

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

export interface CodexAuthValidation {
	ok: boolean;
	parsed?: CodexAuthBlob;
	error?: string;
}

export function validateCodexAuthJson(raw: string): CodexAuthValidation {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'auth.json contents are not valid JSON' };
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: 'auth.json must be a JSON object' };
	}

	const blob = parsed as Record<string, unknown>;
	const tokens = blob.tokens;
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

	return { ok: true, parsed: blob as CodexAuthBlob };
}

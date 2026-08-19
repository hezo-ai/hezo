import { AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	validateAnthropicOauthToken,
	validateCodexAuthJson,
	validateSubscriptionBlob,
} from '../src/services/subscription-auth';

describe('validateCodexAuthJson', () => {
	it('rejects non-JSON input', () => {
		const result = validateCodexAuthJson('not-json');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('valid JSON');
	});

	it('rejects JSON arrays', () => {
		const result = validateCodexAuthJson('[]');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('JSON object');
	});

	it('rejects objects missing the tokens field', () => {
		const result = validateCodexAuthJson('{"OPENAI_API_KEY":"sk-..."}');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('tokens');
	});

	it('rejects tokens without refresh_token', () => {
		const result = validateCodexAuthJson(
			JSON.stringify({ tokens: { access_token: 'a', id_token: 'b' } }),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('refresh_token');
	});

	it('rejects empty refresh_token', () => {
		const result = validateCodexAuthJson(JSON.stringify({ tokens: { refresh_token: '' } }));
		expect(result.ok).toBe(false);
	});

	it('accepts a minimal valid blob with only refresh_token', () => {
		const result = validateCodexAuthJson(JSON.stringify({ tokens: { refresh_token: 'rt-x' } }));
		expect(result.ok).toBe(true);
	});

	it('accepts the full shape produced by `codex login`', () => {
		const blob = {
			OPENAI_API_KEY: null,
			tokens: {
				id_token: 'id.jwt',
				access_token: 'access.jwt',
				refresh_token: 'refresh-x',
				account_id: 'acct-1',
				last_refresh: '2026-04-27T00:00:00Z',
			},
			cli_auth_credentials_store: 'file',
		};
		const result = validateCodexAuthJson(JSON.stringify(blob));
		expect(result.ok).toBe(true);
	});
});

describe('validateAnthropicOauthToken', () => {
	it('rejects an empty token', () => {
		const result = validateAnthropicOauthToken('   ');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('claude setup-token');
	});

	it('rejects an API key pasted instead of a setup-token', () => {
		const result = validateAnthropicOauthToken('sk-ant-api03-abc');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('sk-ant-oat01');
	});

	it('accepts a setup-token (sk-ant-oat01-…), trimming whitespace', () => {
		const result = validateAnthropicOauthToken('  sk-ant-oat01-deadbeef  ');
		expect(result.ok).toBe(true);
	});
});

describe('validateSubscriptionBlob', () => {
	it('dispatches Anthropic to the OAuth-token validator', () => {
		const ok = validateSubscriptionBlob(AiProvider.Anthropic, 'sk-ant-oat01-token');
		expect(ok.ok).toBe(true);
		const bad = validateSubscriptionBlob(AiProvider.Anthropic, 'sk-ant-api03-token');
		expect(bad.ok).toBe(false);
	});

	it('dispatches OpenAI to the codex validator', () => {
		const ok = validateSubscriptionBlob(
			AiProvider.OpenAI,
			JSON.stringify({ tokens: { refresh_token: 'rt' } }),
		);
		expect(ok.ok).toBe(true);
		const bad = validateSubscriptionBlob(AiProvider.OpenAI, '{}');
		expect(bad.ok).toBe(false);
	});

	it('reports that Google does not support subscription auth', () => {
		const res = validateSubscriptionBlob(
			AiProvider.Google,
			JSON.stringify({ refresh_token: 'rt' }),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/does not support subscription auth/);
	});

	it('rejects providers that have no subscription support (incl. Kimi)', () => {
		const result = validateSubscriptionBlob(AiProvider.DeepSeek, '{}');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('does not support subscription');
		// Kimi runs on Claude Code against Moonshot (api-key only) — no subscription.
		const kimi = validateSubscriptionBlob(
			AiProvider.Kimi,
			JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
		);
		expect(kimi.ok).toBe(false);
		expect(kimi.error).toContain('does not support subscription');
	});
});

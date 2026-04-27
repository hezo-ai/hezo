import { AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	validateCodexAuthJson,
	validateGeminiAuthJson,
	validateSubscriptionBlob,
} from '../../services/subscription-auth';

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

describe('validateGeminiAuthJson', () => {
	it('rejects non-JSON input', () => {
		const result = validateGeminiAuthJson('not-json');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('valid JSON');
	});

	it('rejects JSON arrays', () => {
		const result = validateGeminiAuthJson('[]');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('JSON object');
	});

	it('rejects blobs without refresh_token', () => {
		const result = validateGeminiAuthJson(
			JSON.stringify({ access_token: 'ya29.x', token_type: 'Bearer' }),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('refresh_token');
	});

	it('rejects empty refresh_token', () => {
		const result = validateGeminiAuthJson(JSON.stringify({ refresh_token: '' }));
		expect(result.ok).toBe(false);
	});

	it('accepts the standard Google Credentials shape', () => {
		const blob = {
			access_token: 'ya29.access',
			refresh_token: '1//0g-rt',
			token_type: 'Bearer',
			scope: 'https://www.googleapis.com/auth/generative-language',
			expiry_date: 1745780000000,
		};
		const result = validateGeminiAuthJson(JSON.stringify(blob));
		expect(result.ok).toBe(true);
	});
});

describe('validateSubscriptionBlob', () => {
	it('dispatches OpenAI to the codex validator', () => {
		const ok = validateSubscriptionBlob(
			AiProvider.OpenAI,
			JSON.stringify({ tokens: { refresh_token: 'rt' } }),
		);
		expect(ok.ok).toBe(true);
		const bad = validateSubscriptionBlob(AiProvider.OpenAI, '{}');
		expect(bad.ok).toBe(false);
	});

	it('dispatches Google to the gemini validator', () => {
		const ok = validateSubscriptionBlob(AiProvider.Google, JSON.stringify({ refresh_token: 'rt' }));
		expect(ok.ok).toBe(true);
		const bad = validateSubscriptionBlob(AiProvider.Google, '{}');
		expect(bad.ok).toBe(false);
	});

	it('rejects providers that have no subscription support', () => {
		const result = validateSubscriptionBlob(AiProvider.Anthropic, '{}');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('does not support subscription');
	});
});

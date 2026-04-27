import { describe, expect, it } from 'vitest';
import { validateCodexAuthJson } from '../../services/codex-auth';

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
		expect(result.parsed?.tokens.refresh_token).toBe('rt-x');
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
		expect(result.parsed?.tokens.account_id).toBe('acct-1');
	});
});

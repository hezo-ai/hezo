import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import { signState, verifyState } from '../../services/oauth/state';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	masterKeyManager = ctx.masterKeyManager;
	await safeClose(ctx.db);
});

afterAll(() => {});

describe('oauth state signing', () => {
	it('round-trips a state through sign and verify', async () => {
		const { state, codeVerifier, codeChallenge } = await signState(masterKeyManager, {
			companyId: 'aaaa',
			provider: 'datocms',
			redirectUri: 'http://127.0.0.1:3100/api/oauth/callback',
			returnTo: '/companies/x/connections',
			mcpConnectionId: 'mcp-1',
		});
		expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

		const payload = await verifyState(masterKeyManager, state);
		expect(payload).not.toBeNull();
		expect(payload?.companyId).toBe('aaaa');
		expect(payload?.provider).toBe('datocms');
		expect(payload?.codeVerifier).toBe(codeVerifier);
		expect(payload?.mcpConnectionId).toBe('mcp-1');
	});

	it('rejects a tampered state', async () => {
		const { state } = await signState(masterKeyManager, {
			companyId: 'aaaa',
			provider: 'p',
			redirectUri: 'http://x/cb',
			returnTo: '/',
		});
		const [payload, sig] = state.split('.');
		const tampered = `${payload.slice(0, -1)}A.${sig}`;
		const verified = await verifyState(masterKeyManager, tampered);
		expect(verified).toBeNull();
	});

	it('rejects a state with a different signature', async () => {
		const { state } = await signState(masterKeyManager, {
			companyId: 'aaaa',
			provider: 'p',
			redirectUri: 'http://x/cb',
			returnTo: '/',
		});
		const [payload] = state.split('.');
		const verified = await verifyState(masterKeyManager, `${payload}.AAAA`);
		expect(verified).toBeNull();
	});

	it('rejects a malformed state', async () => {
		expect(await verifyState(masterKeyManager, 'not-a-state')).toBeNull();
		expect(await verifyState(masterKeyManager, '')).toBeNull();
	});
});

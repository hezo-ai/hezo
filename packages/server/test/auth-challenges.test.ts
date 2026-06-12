import { describe, expect, it } from 'vitest';
import { AuthChallengeStore } from '../src/services/auth-challenges';

describe('AuthChallengeStore', () => {
	it('issues 64-hex nonces with unique ids', () => {
		const store = new AuthChallengeStore();
		const a = store.issue();
		const b = store.issue();
		expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
		expect(a.challengeId).not.toBe(b.challengeId);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.expiresInSeconds).toBeGreaterThan(0);
	});

	it('consume is single-use', () => {
		const store = new AuthChallengeStore();
		const { challengeId, nonce } = store.issue();
		expect(store.consume(challengeId)?.nonce).toBe(nonce);
		expect(store.consume(challengeId)).toBeNull();
	});

	it('returns null for unknown ids', () => {
		const store = new AuthChallengeStore();
		expect(store.consume('00000000-0000-4000-8000-000000000000')).toBeNull();
	});

	it('honors expiry', async () => {
		const store = new AuthChallengeStore({ ttlMs: 1 });
		const { challengeId } = store.issue();
		await new Promise((r) => setTimeout(r, 10));
		expect(store.consume(challengeId)).toBeNull();
	});

	it('evicts oldest entries beyond the cap', () => {
		const store = new AuthChallengeStore({ maxOutstanding: 3 });
		const first = store.issue();
		const rest = [store.issue(), store.issue(), store.issue()];
		expect(store.consume(first.challengeId)).toBeNull();
		for (const c of rest) {
			expect(store.consume(c.challengeId)?.nonce).toBe(c.nonce);
		}
	});
});

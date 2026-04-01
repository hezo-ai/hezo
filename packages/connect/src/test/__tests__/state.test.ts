import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateStateKeyPair } from '../../config.js';
import {
	createNonce,
	NonceStore,
	type StatePayload,
	signState,
	verifyState,
} from '../../crypto/state.js';

describe('signState + verifyState (Ed25519)', () => {
	const { privateKey, publicKey } = generateStateKeyPair();
	const payload: StatePayload = {
		callback_url: 'http://localhost:3100/oauth/callback',
		platform: 'github',
		nonce: 'test-nonce-123',
		timestamp: '2026-03-30T12:00:00Z',
	};

	it('roundtrips successfully', () => {
		const signed = signState(payload, privateKey);
		const result = verifyState(signed, publicKey);
		expect(result).toEqual(payload);
	});

	it('preserves original_state when present', () => {
		const withState = { ...payload, original_state: 'user-state-abc' };
		const signed = signState(withState, privateKey);
		const result = verifyState(signed, publicKey);
		expect(result).toEqual(withState);
	});

	it('returns null for tampered payload', () => {
		const signed = signState(payload, privateKey);
		const [_encoded, signature] = signed.split('.');
		const tampered =
			Buffer.from(JSON.stringify({ ...payload, platform: 'evil' })).toString('base64url') +
			'.' +
			signature;
		expect(verifyState(tampered, publicKey)).toBeNull();
	});

	it('returns null for tampered signature', () => {
		const signed = signState(payload, privateKey);
		const tampered = `${signed.slice(0, -4)}xxxx`;
		expect(verifyState(tampered, publicKey)).toBeNull();
	});

	it('returns null with a different keypair', () => {
		const other = generateStateKeyPair();
		const signed = signState(payload, privateKey);
		expect(verifyState(signed, other.publicKey)).toBeNull();
	});

	it('returns null for input without a dot separator', () => {
		expect(verifyState('nodothere', publicKey)).toBeNull();
	});

	it('returns null for completely invalid input', () => {
		expect(verifyState('', publicKey)).toBeNull();
		expect(verifyState('abc.def', publicKey)).toBeNull();
	});
});

describe('createNonce', () => {
	it('returns a UUID string', () => {
		const nonce = createNonce();
		expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('returns unique values', () => {
		const a = createNonce();
		const b = createNonce();
		expect(a).not.toBe(b);
	});
});

describe('NonceStore', () => {
	let store: NonceStore;

	beforeEach(() => {
		store = new NonceStore();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('add and consume succeeds', () => {
		store.add('nonce-1');
		expect(store.consume('nonce-1')).toBe(true);
	});

	it('consume same nonce twice fails', () => {
		store.add('nonce-2');
		expect(store.consume('nonce-2')).toBe(true);
		expect(store.consume('nonce-2')).toBe(false);
	});

	it('consume unknown nonce fails', () => {
		expect(store.consume('unknown')).toBe(false);
	});

	it('expired nonces are not consumable', () => {
		store.add('nonce-3');
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		expect(store.consume('nonce-3')).toBe(false);
	});

	it('non-expired nonces remain consumable', () => {
		store.add('nonce-4');
		vi.advanceTimersByTime(4 * 60 * 1000);
		expect(store.consume('nonce-4')).toBe(true);
	});
});

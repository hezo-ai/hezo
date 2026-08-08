import { describe, expect, it } from 'vitest';
import { connectFailureHint, isRetryableConnectError } from '../src/db/postgres-connect-errors';

function err(code: string, message = 'boom'): Error {
	return Object.assign(new Error(message), { code });
}

describe('connectFailureHint', () => {
	it('names the CA remedy for every untrusted-chain code', () => {
		for (const code of [
			'SELF_SIGNED_CERT_IN_CHAIN',
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			'UNABLE_TO_GET_ISSUER_CERT',
			'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
			'CERT_UNTRUSTED',
		]) {
			expect(connectFailureHint(err(code)), code).toMatch(/sslrootcert=\/path\/to\/ca\.crt/);
		}
	});

	it('classifies on the message when the code is missing', () => {
		// Wrappers drop `code`, and the wording differs between runtimes: Node
		// writes "self-signed", Bun's OpenSSL build writes "self signed".
		for (const message of [
			'self signed certificate in certificate chain',
			'self-signed certificate in certificate chain',
			'unable to verify the first certificate',
			'unable to get local issuer certificate',
		]) {
			expect(connectFailureHint(new Error(message)), message).toMatch(/does not trust/);
		}
	});

	it('walks the cause chain', () => {
		const wrapped = new Error('could not connect', { cause: err('SELF_SIGNED_CERT_IN_CHAIN') });
		expect(connectFailureHint(wrapped)).toMatch(/does not trust/);
		expect(isRetryableConnectError(wrapped)).toBe(false);
	});

	it('distinguishes expiry, hostname mismatch and a server refusing TLS', () => {
		expect(connectFailureHint(err('CERT_HAS_EXPIRED'))).toMatch(/expired or not yet valid/);
		expect(connectFailureHint(err('ERR_TLS_CERT_ALTNAME_INVALID'))).toMatch(
			/does not match its TLS certificate/,
		);
		expect(connectFailureHint(new Error('The server does not support SSL connections'))).toMatch(
			/running with ssl=off/,
		);
	});

	it('explains credential, database and socket failures', () => {
		expect(connectFailureHint(err('28P01'))).toMatch(/rejected the credentials/);
		expect(connectFailureHint(err('3D000'))).toMatch(/does not exist/);
		expect(connectFailureHint(err('ECONNREFUSED'))).toMatch(/Nothing is listening/);
		expect(connectFailureHint(err('ENOTFOUND'))).toMatch(/did not resolve/);
		expect(connectFailureHint(err('ETIMEDOUT'))).toMatch(/timed out/);
	});

	it('reads a resolution failure the same however the runtime spells it', () => {
		// Node reports getaddrinfo codes; Bun reports the c-ares status codes for
		// the same failures, so an unresolvable host must produce the DNS hint on
		// either runtime rather than falling through to the generic answer.
		for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'ENODATA', 'EREFUSED', 'ETIMEOUT']) {
			expect(connectFailureHint(err(code)), code).toMatch(/did not resolve/);
		}
	});

	it('keeps the resolver timeout distinct from the socket timeout', () => {
		expect(connectFailureHint(err('ETIMEOUT'))).toMatch(/did not resolve/);
		expect(connectFailureHint(err('ETIMEDOUT'))).toMatch(/timed out/);
	});

	it('says nothing it cannot back up', () => {
		expect(connectFailureHint(err('EWHATEVER', 'something odd'))).toBeUndefined();
		expect(connectFailureHint('a bare string')).toBeUndefined();
		expect(connectFailureHint(undefined)).toBeUndefined();
	});
});

describe('isRetryableConnectError', () => {
	it('stops on failures that repeat identically', () => {
		for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', '28P01', '3D000']) {
			expect(isRetryableConnectError(err(code)), code).toBe(false);
		}
	});

	it('stops on a server that has TLS switched off', () => {
		expect(isRetryableConnectError(new Error('The server does not support SSL connections'))).toBe(
			false,
		);
	});

	it('keeps retrying transient ones — DNS and sockets settle after a boot', () => {
		for (const code of [
			'ENOTFOUND',
			'ECONNREFUSED',
			'ETIMEDOUT',
			'ECONNRESET',
			'ESERVFAIL',
			'ENODATA',
			'EREFUSED',
			'ETIMEOUT',
		]) {
			expect(isRetryableConnectError(err(code)), code).toBe(true);
		}
		expect(isRetryableConnectError(new Error('connection refused by host'))).toBe(true);
	});
});

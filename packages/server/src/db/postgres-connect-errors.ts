/**
 * Classification of external-Postgres connect failures into operator guidance.
 *
 * The failure that matters most here is a TLS chain rejection: it is by far the
 * most common way a correct connection string fails, it is entirely
 * deterministic (so retrying is wasted time), and the generic "check your TLS
 * settings" advice actively points the wrong way when the certificate itself is
 * the problem rather than the mode.
 *
 * Matching is on `err.code` first because the OpenSSL/Node error constants are
 * stable across Node and Bun, with a message regex as a fallback for wrappers
 * that drop the code and for runtime wording drift (Node appends a
 * `--use-system-ca` suggestion; Bun's OpenSSL build writes "self signed" where
 * Node writes "self-signed").
 */

interface FailureKind {
	/** Error codes and SQLSTATEs that identify this failure. */
	codes: string[];
	/** Message fallbacks for errors that arrive without a code. */
	patterns: RegExp[];
	/** Whether the failure repeats identically, making a retry pointless. */
	deterministic: boolean;
	hint: string;
}

/** Ordered: the first match wins, so the specific TLS cases come before the rest. */
const FAILURE_KINDS: FailureKind[] = [
	{
		codes: [
			'SELF_SIGNED_CERT_IN_CHAIN',
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			'UNABLE_TO_GET_ISSUER_CERT',
			'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
			'CERT_UNTRUSTED',
		],
		patterns: [
			/self[- ]signed certificate/i,
			/unable to verify the first certificate/i,
			/unable to get (local )?issuer certificate/i,
		],
		deterministic: true,
		hint:
			"The database's TLS certificate is signed by a CA this host does not trust. " +
			'That is normal for DigitalOcean, AWS RDS, Azure and self-hosted Postgres, which ' +
			'sign with a provider-private CA. Either download the provider CA certificate and ' +
			'use sslmode=verify-full&sslrootcert=/path/to/ca.crt (verified, recommended), or ' +
			'use sslmode=require to encrypt without verifying the certificate.',
	},
	{
		codes: ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'],
		patterns: [/certificate has expired/i, /certificate is not yet valid/i],
		deterministic: true,
		hint:
			"The database's TLS certificate is expired or not yet valid. Check the clock on " +
			'this host, then renew or rotate the certificate with your provider.',
	},
	{
		codes: ['ERR_TLS_CERT_ALTNAME_INVALID'],
		patterns: [/hostname\/ip does not match/i, /altname/i],
		deterministic: true,
		hint:
			'The database host name does not match its TLS certificate. Connect using the host ' +
			'name the certificate was issued for, or drop to sslmode=require to skip the ' +
			'hostname check.',
	},
	{
		codes: [],
		patterns: [/does not support SSL connections/i],
		deterministic: true,
		hint:
			'The server refused TLS - it is running with ssl=off. Enable TLS on the server, or ' +
			'use sslmode=disable only if the connection stays on a trusted private network.',
	},
	{
		codes: ['28P01', '28000'],
		patterns: [],
		deterministic: true,
		hint: 'The database rejected the credentials. Check the user name and password in the connection string.',
	},
	{
		codes: ['3D000'],
		patterns: [],
		deterministic: true,
		hint: 'The database named in the connection string does not exist. Create it, or point the URL at an existing database.',
	},
	{
		codes: ['ECONNREFUSED'],
		patterns: [],
		deterministic: false,
		hint: 'Nothing is listening on that host and port. Check the port and that the database allows connections from this host.',
	},
	{
		// Both spellings of a resolution failure land here: Node surfaces
		// getaddrinfo codes, while Bun's resolver surfaces the underlying c-ares
		// status codes for the same failures. Note that the c-ares timeout is
		// spelled without the trailing D that the socket timeout carries, so it
		// is unambiguously a resolver that did not answer.
		codes: ['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'ENODATA', 'EREFUSED', 'ETIMEOUT'],
		patterns: [],
		deterministic: false,
		hint: 'The database host name did not resolve. Check the host name and this machine DNS settings.',
	},
	{
		codes: ['ETIMEDOUT'],
		patterns: [],
		deterministic: false,
		hint: 'The connection timed out. Check firewall and trusted-source rules between this host and the database.',
	},
];

const MAX_CAUSE_DEPTH = 3;

/** Flatten an error and its `cause` chain into codes and messages to match on. */
function collect(err: unknown): { codes: Set<string>; message: string } {
	const codes = new Set<string>();
	const messages: string[] = [];
	let current: unknown = err;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current; depth++) {
		if (typeof current !== 'object') {
			messages.push(String(current));
			break;
		}
		const record = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (typeof record.code === 'string') codes.add(record.code);
		if (typeof record.message === 'string') messages.push(record.message);
		current = record.cause;
	}
	return { codes, message: messages.join(' ') };
}

function classify(err: unknown): FailureKind | undefined {
	const { codes, message } = collect(err);
	return FAILURE_KINDS.find(
		(kind) =>
			kind.codes.some((code) => codes.has(code)) ||
			kind.patterns.some((pattern) => pattern.test(message)),
	);
}

/**
 * Actionable one-liner for a connect failure, or undefined when the cause isn't
 * one we can say anything specific about.
 */
export function connectFailureHint(err: unknown): string | undefined {
	return classify(err)?.hint;
}

/**
 * Whether retrying could plausibly succeed. A rejected certificate or a bad
 * password fails identically every time, so the retry loop should stop rather
 * than spend its backoff re-proving it. DNS and sockets stay retryable - they
 * genuinely are transient while a freshly provisioned host settles.
 */
export function isRetryableConnectError(err: unknown): boolean {
	return !classify(err)?.deterministic;
}

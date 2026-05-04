import type { PGlite } from '@electric-sql/pglite';
import { decrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';

/**
 * Token agents emit in headers and URLs in place of real secret values.
 * The egress proxy intercepts every outbound request and substitutes
 * these tokens with the matching `secrets.name` from the caller's
 * company before the request leaves the host. Bodies are forwarded
 * unchanged — agents that need a secret in a JSON payload should use
 * the local-MCP-with-proxy pattern instead.
 */
export const PLACEHOLDER_REGEX = /__HEZO_SECRET_([A-Z0-9_]+)__/g;
export const PLACEHOLDER_PROBE_REGEX = /__HEZO_SECRET_/;

export interface SubstitutionScope {
	db: PGlite;
	masterKeyManager: MasterKeyManager;
	companyId: string;
	projectId?: string | null;
}

export interface ResolvedSecret {
	name: string;
	value: string;
	allowedHosts: string[];
	allowAllHosts: boolean;
}

export type SubstitutionFailure =
	| { kind: 'unknown_secret'; name: string }
	| { kind: 'secret_not_allowed_for_host'; name: string; host: string }
	| { kind: 'secrets_unavailable' };

export interface SubstitutionResult {
	headers: Record<string, string | string[]>;
	url: string;
	headersChanged: boolean;
	urlChanged: boolean;
	secretsUsed: Set<string>;
	failure: SubstitutionFailure | null;
}

interface RequestInputs {
	url: string;
	headers: Record<string, string | string[] | undefined>;
	method: string;
	host: string;
}

export async function loadSecretsForScope(
	scope: SubstitutionScope,
): Promise<Map<string, ResolvedSecret>> {
	const key = scope.masterKeyManager.getKey();
	if (!key) {
		const err = new Error('LOCKED');
		err.name = 'MasterKeyLocked';
		throw err;
	}

	const params: unknown[] = [scope.companyId];
	let where = 'company_id = $1';
	if (scope.projectId) {
		where += ' AND (project_id IS NULL OR project_id = $2)';
		params.push(scope.projectId);
	} else {
		where += ' AND project_id IS NULL';
	}

	const result = await scope.db.query<{
		name: string;
		encrypted_value: string;
		allowed_hosts: string[];
		allow_all_hosts: boolean;
		project_id: string | null;
	}>(
		`SELECT name, encrypted_value, allowed_hosts, allow_all_hosts, project_id
		 FROM secrets
		 WHERE ${where}
		 ORDER BY project_id NULLS FIRST`,
		params,
	);

	const out = new Map<string, ResolvedSecret>();
	for (const row of result.rows) {
		// Project-scoped rows arrive after company-scoped rows in the ordering
		// so the project row wins on identical names.
		out.set(row.name, {
			name: row.name,
			value: decrypt(row.encrypted_value, key),
			allowedHosts: row.allowed_hosts ?? [],
			allowAllHosts: row.allow_all_hosts,
		});
	}
	return out;
}

export function substituteRequest(
	input: RequestInputs,
	secrets: Map<string, ResolvedSecret>,
): SubstitutionResult {
	const secretsUsed = new Set<string>();
	const checkAccess = (name: string): SubstitutionFailure | null => {
		const secret = secrets.get(name);
		if (!secret) return { kind: 'unknown_secret', name };
		if (
			!secret.allowAllHosts &&
			(secret.allowedHosts.length === 0 || !hostMatchesAllowlist(input.host, secret.allowedHosts))
		) {
			return { kind: 'secret_not_allowed_for_host', name, host: input.host };
		}
		return null;
	};

	let failure: SubstitutionFailure | null = null;

	const headersOut: Record<string, string | string[]> = {};
	let headersChanged = false;
	for (const [name, raw] of Object.entries(input.headers)) {
		if (raw === undefined) continue;
		if (Array.isArray(raw)) {
			const replaced: string[] = [];
			for (const value of raw) {
				const out = applyToString(value, secrets, secretsUsed, checkAccess);
				if (out.failure) failure ??= out.failure;
				if (out.changed) headersChanged = true;
				replaced.push(out.value);
			}
			headersOut[name] = replaced;
		} else {
			const out = applyToString(raw, secrets, secretsUsed, checkAccess);
			if (out.failure) failure ??= out.failure;
			if (out.changed) headersChanged = true;
			headersOut[name] = out.value;
		}
	}

	const urlOut = applyToString(input.url, secrets, secretsUsed, checkAccess);
	if (urlOut.failure) failure ??= urlOut.failure;

	return {
		headers: headersOut,
		url: urlOut.value,
		headersChanged,
		urlChanged: urlOut.changed,
		secretsUsed,
		failure,
	};
}

interface ApplyResult {
	value: string;
	changed: boolean;
	failure: SubstitutionFailure | null;
}

function applyToString(
	input: string,
	secrets: Map<string, ResolvedSecret>,
	secretsUsed: Set<string>,
	checkAccess: (name: string) => SubstitutionFailure | null,
): ApplyResult {
	if (!PLACEHOLDER_PROBE_REGEX.test(input)) {
		return { value: input, changed: false, failure: null };
	}
	let failure: SubstitutionFailure | null = null;
	const result = input.replace(PLACEHOLDER_REGEX, (match, name: string) => {
		const access = checkAccess(name);
		if (access) {
			failure ??= access;
			return match;
		}
		const secret = secrets.get(name);
		if (!secret) {
			failure ??= { kind: 'unknown_secret', name };
			return match;
		}
		secretsUsed.add(name);
		return secret.value;
	});
	return { value: result, changed: result !== input, failure };
}

function hostMatchesAllowlist(host: string, allowedHosts: string[]): boolean {
	const normalized = host.toLowerCase();
	for (const allowed of allowedHosts) {
		const expected = allowed.toLowerCase();
		if (expected.startsWith('*.')) {
			const suffix = expected.slice(1);
			if (normalized.endsWith(suffix)) return true;
		} else if (normalized === expected) {
			return true;
		}
	}
	return false;
}

import type { PGlite } from '@electric-sql/pglite';
import { decrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

const PLACEHOLDER_RE = /__HEZO_SECRET_([A-Za-z0-9_]+)__/g;

export const MAX_SUBSTITUTION_BYTES = 1 * 1024 * 1024;

const BINARY_CONTENT_TYPES = [
	/^application\/octet-stream/i,
	/^image\//i,
	/^video\//i,
	/^audio\//i,
	/^application\/pdf/i,
	/^application\/zip/i,
	/^application\/x-tar/i,
	/^application\/gzip/i,
];

export interface GrantedSecret {
	id: string;
	name: string;
	plaintext: string;
	hostAllowlist: string[];
}

interface SecretGrantRow {
	id: string;
	name: string;
	encrypted_value: string;
	host_allowlist: string[] | null;
}

export async function loadGrantedSecrets(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	memberId: string,
): Promise<Map<string, GrantedSecret>> {
	const key = masterKeyManager.getKey();
	if (!key) return new Map();

	const result = await db.query<SecretGrantRow>(
		`SELECT s.id, s.name, s.encrypted_value, s.host_allowlist
		   FROM secret_grants sg
		   JOIN secrets s ON s.id = sg.secret_id
		  WHERE sg.member_id = $1 AND sg.revoked_at IS NULL`,
		[memberId],
	);

	const out = new Map<string, GrantedSecret>();
	for (const row of result.rows) {
		const plaintext = decrypt(row.encrypted_value, key);
		out.set(row.name, {
			id: row.id,
			name: row.name,
			plaintext,
			hostAllowlist: Array.isArray(row.host_allowlist) ? row.host_allowlist : [],
		});
	}
	return out;
}

export interface SubstitutionResult {
	output: string;
	referenced: GrantedSecret[];
	ungrantedNames: string[];
}

export function substitute(input: string, granted: Map<string, GrantedSecret>): SubstitutionResult {
	const referencedById = new Map<string, GrantedSecret>();
	const ungranted = new Set<string>();
	const output = input.replace(PLACEHOLDER_RE, (_match, name: string) => {
		const secret = granted.get(name);
		if (!secret) {
			ungranted.add(name);
			return _match;
		}
		referencedById.set(secret.id, secret);
		return secret.plaintext;
	});
	return {
		output,
		referenced: Array.from(referencedById.values()),
		ungrantedNames: Array.from(ungranted),
	};
}

export function hostMatches(host: string, patterns: string[]): boolean {
	const normalized = host.toLowerCase();
	for (const raw of patterns) {
		const pattern = raw.toLowerCase();
		if (pattern.startsWith('*.')) {
			const suffix = pattern.slice(2);
			if (normalized === suffix) continue;
			if (normalized.endsWith(`.${suffix}`)) return true;
		} else if (normalized === pattern) {
			return true;
		}
	}
	return false;
}

export function isBinaryContentType(ct: string | null | undefined): boolean {
	if (!ct) return false;
	const head = ct.split(';')[0].trim();
	return BINARY_CONTENT_TYPES.some((re) => re.test(head));
}

const HOST_PATTERN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function isValidHostPattern(value: string): boolean {
	if (typeof value !== 'string') return false;
	if (value.length === 0 || value.length > 253) return false;
	return HOST_PATTERN_RE.test(value);
}

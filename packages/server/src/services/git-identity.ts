import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { listConnections } from './oauth/connection-store';

/**
 * Git author/committer identity plus an optional SSH commit-signing key,
 * resolved from the team's connected GitHub account and Ed25519 key.
 */
export interface GitIdentity {
	name: string;
	email: string;
	/** SSH public-key literal (`ssh-ed25519 AAAA... hezo`) for `user.signingkey`. */
	signingKey: string | null;
}

const FALLBACK_IDENTITY = { name: 'Hezo Agent', email: 'agent@hezo.local' };

/**
 * Derive a Git author identity from a GitHub OAuth connection's stored metadata.
 * The email uses GitHub's privacy-preserving noreply form so commits remain
 * attributable and Verifiable regardless of the account's email privacy setting.
 */
export function deriveGitHubIdentity(
	metadata: Record<string, unknown>,
	fallbackLabel: string,
): { name: string; email: string } | null {
	const login = typeof metadata.login === 'string' ? metadata.login : fallbackLabel;
	const userId = metadata.github_user_id;
	if (!login || (typeof userId !== 'number' && typeof userId !== 'string')) return null;
	return {
		name: login,
		email: `${userId}+${login}@users.noreply.github.com`,
	};
}

/**
 * Translate a resolved identity into `GIT_CONFIG_*` env entries. Git applies
 * these to every invocation (git ≥ 2.31), so the container needs no `.gitconfig`
 * file and no writable HOME. Signing config is emitted only when a key exists;
 * the actual signature is produced by `ssh-keygen -Y sign` against the private
 * key reachable through `SSH_AUTH_SOCK`.
 */
export function gitConfigEnv(identity: GitIdentity): string[] {
	const entries: Array<[string, string]> = [
		['user.name', identity.name],
		['user.email', identity.email],
	];
	if (identity.signingKey) {
		entries.push(
			['gpg.format', 'ssh'],
			['user.signingkey', identity.signingKey],
			['commit.gpgsign', 'true'],
		);
	}
	const env = [`GIT_CONFIG_COUNT=${entries.length}`];
	entries.forEach(([key, value], i) => {
		env.push(`GIT_CONFIG_KEY_${i}=${key}`, `GIT_CONFIG_VALUE_${i}=${value}`);
	});
	return env;
}

/**
 * Resolve the Git identity: author/committer from the project's own GitHub
 * connection (a global "all projects" connection is the fallback; the project's
 * own always wins), and the commit-signing key from the team's own Ed25519 key
 * (the signing identity stays per-team). Falls back to a generic identity so
 * `git commit` never fails for lack of a configured author. `listConnections`
 * already orders the project's own connections ahead of global ones, so the
 * first github row is the correct one for this project.
 */
export async function resolveGitIdentity(
	db: Db,
	masterKeyManager: MasterKeyManager,
	scope: { projectId: string; teamId: string },
): Promise<GitIdentity> {
	const connections = await listConnections({ db, masterKeyManager }, scope.projectId);
	const github = connections.find((c) => c.provider === 'github');
	const derived = github
		? deriveGitHubIdentity(github.metadata, github.providerAccountLabel)
		: null;

	const keyRow = await db.query<{ public_key: string }>(
		`SELECT public_key FROM team_ssh_keys WHERE team_id = $1`,
		[scope.teamId],
	);

	return {
		...(derived ?? FALLBACK_IDENTITY),
		signingKey: keyRow.rows[0]?.public_key ?? null,
	};
}

/** Convenience: resolve the identity and return its `GIT_CONFIG_*` env entries. */
export async function buildGitIdentityEnv(
	db: Db,
	masterKeyManager: MasterKeyManager,
	scope: { projectId: string; teamId: string },
): Promise<string[]> {
	return gitConfigEnv(await resolveGitIdentity(db, masterKeyManager, scope));
}

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import {
	buildGitIdentityEnv,
	deriveGitHubIdentity,
	gitConfigEnv,
} from '../src/services/git-identity';
import { createConnection } from '../src/services/oauth/connection-store';
import { generateTeamSSHKey } from '../src/services/ssh-keys';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

/** Parse the GIT_CONFIG_* env entries back into a { 'user.name': '…' } map. */
function parseGitConfig(env: string[]): Record<string, string> {
	const get = (k: string) => env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
	const count = Number(get('GIT_CONFIG_COUNT'));
	const out: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		out[get(`GIT_CONFIG_KEY_${i}`) as string] = get(`GIT_CONFIG_VALUE_${i}`) as string;
	}
	return out;
}

async function makeTeam(slug: string): Promise<string> {
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
		[slug, slug],
	);
	return team.rows[0].id;
}

describe('deriveGitHubIdentity', () => {
	it('builds name + privacy-form noreply email from metadata', () => {
		expect(deriveGitHubIdentity({ login: 'octocat', github_user_id: 12345 }, 'octocat')).toEqual({
			name: 'octocat',
			email: '12345+octocat@users.noreply.github.com',
		});
	});

	it('falls back to the connection label when metadata has no login', () => {
		expect(deriveGitHubIdentity({ github_user_id: 7 }, 'fallback-login')).toEqual({
			name: 'fallback-login',
			email: '7+fallback-login@users.noreply.github.com',
		});
	});

	it('returns null when the github user id is missing', () => {
		expect(deriveGitHubIdentity({ login: 'octocat' }, 'octocat')).toBeNull();
	});
});

describe('gitConfigEnv', () => {
	it('emits only name + email when there is no signing key', () => {
		const env = gitConfigEnv({ name: 'A', email: 'a@b.c', signingKey: null });
		expect(parseGitConfig(env)).toEqual({ 'user.name': 'A', 'user.email': 'a@b.c' });
	});

	it('emits signing config when a key is present', () => {
		const env = gitConfigEnv({ name: 'A', email: 'a@b.c', signingKey: 'ssh-ed25519 AAAA hezo' });
		expect(parseGitConfig(env)).toEqual({
			'user.name': 'A',
			'user.email': 'a@b.c',
			'gpg.format': 'ssh',
			'user.signingkey': 'ssh-ed25519 AAAA hezo',
			'commit.gpgsign': 'true',
		});
	});
});

describe('buildGitIdentityEnv', () => {
	it('derives identity from the GitHub connection and signs with the team key', async () => {
		const teamId = await makeTeam('gh-team');
		const key = await generateTeamSSHKey(db, teamId, masterKeyManager);
		await createConnection(
			{ db, masterKeyManager },
			{
				teamId,
				provider: 'github',
				providerAccountId: '12345',
				providerAccountLabel: 'octocat',
				accessToken: 'gho_x',
				scopes: ['repo'],
				allowedHosts: ['github.com'],
				metadata: { login: 'octocat', github_user_id: 12345, email: null },
			},
		);

		const cfg = parseGitConfig(await buildGitIdentityEnv(db, masterKeyManager, teamId));
		expect(cfg['user.name']).toBe('octocat');
		expect(cfg['user.email']).toBe('12345+octocat@users.noreply.github.com');
		expect(cfg['gpg.format']).toBe('ssh');
		expect(cfg['user.signingkey']).toBe(key.publicKey);
		expect(cfg['commit.gpgsign']).toBe('true');
	});

	it('falls back to a generic identity with no signing when nothing is connected', async () => {
		const teamId = await makeTeam('bare-team');
		const cfg = parseGitConfig(await buildGitIdentityEnv(db, masterKeyManager, teamId));
		expect(cfg).toEqual({ 'user.name': 'Hezo Agent', 'user.email': 'agent@hezo.local' });
	});

	it('signs with the team key even when no GitHub account is connected', async () => {
		const teamId = await makeTeam('key-only-team');
		const key = await generateTeamSSHKey(db, teamId, masterKeyManager);
		const cfg = parseGitConfig(await buildGitIdentityEnv(db, masterKeyManager, teamId));
		expect(cfg['user.name']).toBe('Hezo Agent');
		expect(cfg['user.signingkey']).toBe(key.publicKey);
		expect(cfg['commit.gpgsign']).toBe('true');
	});
});

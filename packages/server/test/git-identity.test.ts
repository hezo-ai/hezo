import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	buildGitIdentityEnv,
	deriveGitHubIdentity,
	gitConfigEnv,
} from '../src/services/git-identity';
import { createConnection } from '../src/services/oauth/connection-store';
import { generateTeamSSHKey } from '../src/services/ssh-keys';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

// OAuth connections are instance-global, so isolate each test's view of them.
beforeEach(async () => {
	await db.query('DELETE FROM oauth_connections');
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

async function makeTeamAndProject(slug: string): Promise<{ teamId: string; projectId: string }> {
	const teamId = await makeTeam(slug);
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, $2, $2, $3) RETURNING id`,
		[
			teamId,
			slug,
			slug
				.toUpperCase()
				.replace(/[^A-Z0-9]/g, '')
				.slice(0, 6) || 'PRJ',
		],
	);
	return { teamId, projectId: project.rows[0].id };
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
	it("derives identity from the project's GitHub connection and signs with the team key", async () => {
		const { teamId, projectId } = await makeTeamAndProject('gh-team');
		const key = await generateTeamSSHKey(db, teamId, masterKeyManager);
		await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: '12345',
				providerAccountLabel: 'octocat',
				accessToken: 'gho_x',
				scopes: ['repo'],
				allowedHosts: ['github.com'],
				projectId,
				metadata: { login: 'octocat', github_user_id: 12345, email: null },
			},
		);

		const cfg = parseGitConfig(
			await buildGitIdentityEnv(db, masterKeyManager, { projectId, teamId }),
		);
		expect(cfg['user.name']).toBe('octocat');
		expect(cfg['user.email']).toBe('12345+octocat@users.noreply.github.com');
		expect(cfg['gpg.format']).toBe('ssh');
		expect(cfg['user.signingkey']).toBe(key.publicKey);
		expect(cfg['commit.gpgsign']).toBe('true');
	});

	it('falls back to a generic identity with no signing when nothing is connected', async () => {
		const { teamId, projectId } = await makeTeamAndProject('bare-team');
		const cfg = parseGitConfig(
			await buildGitIdentityEnv(db, masterKeyManager, { projectId, teamId }),
		);
		expect(cfg).toEqual({ 'user.name': 'Hezo Agent', 'user.email': 'agent@hezo.local' });
	});

	it('signs with the team key even when no GitHub account is connected', async () => {
		const { teamId, projectId } = await makeTeamAndProject('key-only-team');
		const key = await generateTeamSSHKey(db, teamId, masterKeyManager);
		const cfg = parseGitConfig(
			await buildGitIdentityEnv(db, masterKeyManager, { projectId, teamId }),
		);
		expect(cfg['user.name']).toBe('Hezo Agent');
		expect(cfg['user.signingkey']).toBe(key.publicKey);
		expect(cfg['commit.gpgsign']).toBe('true');
	});

	it('resolves each project to its OWN github account (no cross-project bleed)', async () => {
		const a = await makeTeamAndProject('proj-a');
		const b = await makeTeamAndProject('proj-b');
		await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: '111',
				providerAccountLabel: 'account-a',
				accessToken: 'gho_a',
				scopes: ['repo'],
				allowedHosts: ['github.com'],
				projectId: a.projectId,
				metadata: { login: 'account-a', github_user_id: 111 },
			},
		);
		await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: '222',
				providerAccountLabel: 'account-b',
				accessToken: 'gho_b',
				scopes: ['repo'],
				allowedHosts: ['github.com'],
				projectId: b.projectId,
				metadata: { login: 'account-b', github_user_id: 222 },
			},
		);

		const cfgA = parseGitConfig(await buildGitIdentityEnv(db, masterKeyManager, a));
		const cfgB = parseGitConfig(await buildGitIdentityEnv(db, masterKeyManager, b));
		expect(cfgA['user.name']).toBe('account-a');
		expect(cfgB['user.name']).toBe('account-b');
	});

	it('prefers the project connection over a global one', async () => {
		const { teamId, projectId } = await makeTeamAndProject('proj-pref');
		// Global ("all projects") connection, created most-recently…
		await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: '999',
				providerAccountLabel: 'global-acct',
				accessToken: 'gho_g',
				scopes: ['repo'],
				allowedHosts: ['github.com'],
				metadata: { login: 'global-acct', github_user_id: 999 },
			},
		);
		// …plus the project's own — which must win despite being older.
		await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: '333',
				providerAccountLabel: 'project-acct',
				accessToken: 'gho_p',
				scopes: ['repo'],
				allowedHosts: ['github.com'],
				projectId,
				metadata: { login: 'project-acct', github_user_id: 333 },
			},
		);
		const cfg = parseGitConfig(
			await buildGitIdentityEnv(db, masterKeyManager, { projectId, teamId }),
		);
		expect(cfg['user.name']).toBe('project-acct');
	});
});

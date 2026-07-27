import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	computeScopeStatus,
	createGitHubRepo,
	listAccessibleRepos,
	listUserOrgs,
	parseGitHubUrl,
	registerAuthKey,
	requiredRepoSetupScopes,
	validateRepoAccess,
} from '../src/services/github';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

let sim: GitHubSim;
let prevApi: string | undefined;

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
});

describe('parseGitHubUrl', () => {
	it('parses SSH, HTTPS, http, bare-host, and owner/repo shorthand forms', () => {
		expect(parseGitHubUrl('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' });
		expect(parseGitHubUrl('https://github.com/octo/repo')).toEqual({ owner: 'octo', repo: 'repo' });
		expect(parseGitHubUrl('https://github.com/octo/repo.git')).toEqual({
			owner: 'octo',
			repo: 'repo',
		});
		expect(parseGitHubUrl('http://github.com/octo/repo/')).toEqual({ owner: 'octo', repo: 'repo' });
		expect(parseGitHubUrl('github.com/octo/repo')).toEqual({ owner: 'octo', repo: 'repo' });
		expect(parseGitHubUrl('octo/repo')).toEqual({ owner: 'octo', repo: 'repo' });
	});

	it('returns null for a non-GitHub or malformed URL', () => {
		expect(parseGitHubUrl('https://gitlab.com/octo/repo')).toBeNull();
		expect(parseGitHubUrl('not a url')).toBeNull();
		expect(parseGitHubUrl('octo')).toBeNull();
	});
});

describe('computeScopeStatus', () => {
	it('lists the required scopes and reports missing ones', () => {
		const required = requiredRepoSetupScopes();
		expect(computeScopeStatus([]).sufficient).toBe(false);
		expect(computeScopeStatus([]).missing).toEqual(required);
		expect(computeScopeStatus(required).sufficient).toBe(true);
		expect(computeScopeStatus(null).sufficient).toBe(false);
		const partial = computeScopeStatus(['repo']);
		expect(partial.sufficient).toBe(false);
		expect(partial.missing).not.toContain('repo');
	});
});

describe('validateRepoAccess', () => {
	it('returns accessible=true (200) for a repo the token can see', async () => {
		sim.seed({
			token: 'gho_access',
			user: { id: 5, login: 'acc', avatar_url: '', email: null },
			repos: [
				{
					id: 1,
					name: 'visible',
					full_name: 'acc/visible',
					owner: { login: 'acc' },
					private: false,
					default_branch: 'main',
					clone_url: 'https://github.com/acc/visible.git',
					ssh_url: 'git@github.com:acc/visible.git',
				},
			],
		});
		const res = await validateRepoAccess('acc', 'visible', 'gho_access');
		expect(res.accessible).toBe(true);
		expect(res.status).toBe(200);
		expect(res.canPush).toBe(true);
	});

	it('returns accessible=false (404) for a repo that does not exist', async () => {
		sim.seed({ token: 'gho_access', repos: [] });
		const res = await validateRepoAccess('acc', 'nope', 'gho_access');
		expect(res.accessible).toBe(false);
		expect(res.status).toBe(404);
		expect(res.canPush).toBeNull();
	});

	// A 200 only proves read: a read-only collaborator gets one too. Reading
	// `permissions.push` off that same response is what separates "linked and
	// readable" from "an agent's push will land".
	it('reports canPush=false for a repo the account can read but not push to', async () => {
		sim.seed({
			token: 'gho_access',
			user: { id: 5, login: 'acc', avatar_url: '', email: null },
			repos: [
				{
					id: 2,
					name: 'readonly',
					full_name: 'other/readonly',
					owner: { login: 'other' },
					private: true,
					default_branch: 'main',
					clone_url: 'https://github.com/other/readonly.git',
					ssh_url: 'git@github.com:other/readonly.git',
					permissions: { admin: false, push: false, pull: true },
				},
			],
		});
		const res = await validateRepoAccess('other', 'readonly', 'gho_access');
		expect(res.accessible).toBe(true);
		expect(res.canPush).toBe(false);
	});

	it('reports canPush=null when the response carries no usable permissions object', async () => {
		const withBody = (body: unknown) =>
			validateRepoAccess('acc', 'x', 'gho_access', async () =>
				Response.json(body as Record<string, unknown>, { status: 200 }),
			);

		// Unknown must never be reported as write access — a missing signal must
		// not manufacture a permission the account may not have.
		expect((await withBody({ full_name: 'acc/x' })).canPush).toBeNull();
		expect((await withBody({ permissions: null })).canPush).toBeNull();
		expect((await withBody({ permissions: { push: 'yes' } })).canPush).toBeNull();
	});

	it('reports canPush=null when the response body is not JSON', async () => {
		const res = await validateRepoAccess(
			'acc',
			'x',
			'gho_access',
			async () => new Response('<html>gateway error</html>', { status: 200 }),
		);
		expect(res.accessible).toBe(true);
		expect(res.canPush).toBeNull();
	});
});

describe('listUserOrgs', () => {
	it('prepends the authenticated user as a personal org, then lists real orgs', async () => {
		sim.seed({
			token: 'gho_orgs',
			user: { id: 9, login: 'me', avatar_url: 'http://av/me', email: null },
			orgs: [
				{ login: 'acme', avatar_url: 'http://av/acme' },
				{ login: 'globex', avatar_url: 'http://av/globex' },
			],
		});
		const orgs = await listUserOrgs('gho_orgs');
		expect(orgs[0]).toEqual({ login: 'me', avatar_url: 'http://av/me', is_personal: true });
		expect(orgs.map((o) => o.login)).toEqual(['me', 'acme', 'globex']);
		expect(orgs.find((o) => o.login === 'acme')?.is_personal).toBe(false);
	});

	it('returns an empty list when the token is invalid', async () => {
		sim.seed({ token: 'gho_valid', orgs: [] });
		const orgs = await listUserOrgs('gho_invalid');
		// fetchAuthenticatedUser → null (no personal), /user/orgs → 401 → personal only ([]).
		expect(orgs).toEqual([]);
	});
});

describe('listAccessibleRepos', () => {
	it('lists the personal repos (affiliation path) and filters by query', async () => {
		sim.seed({
			token: 'gho_repos',
			user: { id: 11, login: 'dev', avatar_url: '', email: null },
			repos: [
				{
					id: 1,
					name: 'alpha',
					full_name: 'dev/alpha',
					owner: { login: 'dev' },
					private: false,
					default_branch: 'main',
					clone_url: '',
					ssh_url: '',
				},
				{
					id: 2,
					name: 'beta',
					full_name: 'dev/beta',
					owner: { login: 'dev' },
					private: true,
					default_branch: 'main',
					clone_url: '',
					ssh_url: '',
				},
			],
		});
		const all = await listAccessibleRepos('dev', undefined, 'gho_repos');
		expect(all.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);

		const filtered = await listAccessibleRepos('dev', 'alph', 'gho_repos');
		expect(filtered.map((r) => r.name)).toEqual(['alpha']);
	});

	it('uses the org path when the owner is not the authenticated user', async () => {
		sim.seed({
			token: 'gho_org_repos',
			user: { id: 12, login: 'someone', avatar_url: '', email: null },
			repos: [
				{
					id: 3,
					name: 'orgrepo',
					full_name: 'acme/orgrepo',
					owner: { login: 'acme' },
					private: false,
					default_branch: 'main',
					clone_url: '',
					ssh_url: '',
				},
			],
		});
		const repos = await listAccessibleRepos('acme', undefined, 'gho_org_repos');
		expect(repos.map((r) => r.full_name)).toEqual(['acme/orgrepo']);
	});
});

describe('createGitHubRepo', () => {
	it('creates a personal repo (status created)', async () => {
		sim.seed({
			token: 'gho_create',
			user: { id: 20, login: 'creator', avatar_url: '', email: null },
			repos: [],
		});
		const result = await createGitHubRepo('creator', 'brand-new', true, 'gho_create');
		expect(result.status).toBe('created');
		if (result.status === 'created') {
			expect(result.full_name).toBe('creator/brand-new');
			expect(result.private).toBe(true);
			expect(result.default_branch).toBe('main');
		}
	});

	it('surfaces a duplicate name as already_exists rather than throwing', async () => {
		sim.seed({
			token: 'gho_dupe_repo',
			user: { id: 21, login: 'creator2', avatar_url: '', email: null },
			repos: [
				{
					id: 9,
					name: 'taken',
					full_name: 'creator2/taken',
					owner: { login: 'creator2' },
					private: false,
					default_branch: 'main',
					clone_url: '',
					ssh_url: '',
				},
			],
		});
		const result = await createGitHubRepo('creator2', 'taken', false, 'gho_dupe_repo');
		expect(result.status).toBe('already_exists');
		expect(result.owner).toBe('creator2');
		expect(result.name).toBe('taken');
	});

	it('creates an org repo when the owner is not the authenticated user', async () => {
		sim.seed({
			token: 'gho_org_create',
			user: { id: 22, login: 'notowner', avatar_url: '', email: null },
			repos: [],
		});
		const result = await createGitHubRepo('acme', 'org-new', true, 'gho_org_create');
		expect(result.status).toBe('created');
		if (result.status === 'created') expect(result.full_name).toBe('acme/org-new');
	});
});

describe('registerAuthKey', () => {
	it('registers an authentication key', async () => {
		sim.seed({ token: 'gho_authkey', authKeys: [] });
		const result = await registerAuthKey(
			'gho_authkey',
			'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 auth',
			'Hezo authentication key',
		);
		expect(result.status).toBe('created');
		if (result.status === 'created') expect(result.title).toBe('Hezo authentication key');
		expect(sim.state.authKeys).toHaveLength(1);
	});

	it('treats a duplicate auth key as already_exists', async () => {
		const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 auth-dup';
		sim.seed({ token: 'gho_authdup', authKeys: [{ id: 7, title: 'old', key }] });
		const result = await registerAuthKey('gho_authdup', key, 'Hezo authentication key');
		expect(result.status).toBe('already_exists');
	});

	it('throws on a non-422 failure (e.g. 401 unauthorized)', async () => {
		sim.seed({ token: 'gho_valid_key' });
		await expect(
			registerAuthKey('gho_wrong_key', 'ssh-ed25519 AAAA x', 'Hezo authentication key'),
		).rejects.toThrow(/\/user\/keys failed \(401\)/);
	});
});

describe('createGitHubRepo error path', () => {
	it('throws when the API rejects with a non-422 status', async () => {
		// A bad token → 401 from the sim's create endpoint → thrown error (not already_exists).
		sim.seed({ token: 'gho_valid_create', repos: [] });
		await expect(createGitHubRepo('whoever', 'x', true, 'gho_bad_create')).rejects.toThrow(
			/Failed to create GitHub repo \(401\)/,
		);
	});
});

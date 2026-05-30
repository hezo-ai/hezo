import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchAccount, registerSigningKey } from '../src/services/oauth/provider-github';
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

describe('GitHub REST helpers', () => {
	it('fetches account info using the access token', async () => {
		sim.seed({
			token: 'gho_account',
			user: { id: 42, login: 'alice', avatar_url: 'http://x/avatar.png', email: 'alice@x' },
		});
		const account = await fetchAccount('gho_account');
		expect(account).toEqual({
			id: 42,
			login: 'alice',
			avatarUrl: 'http://x/avatar.png',
			email: 'alice@x',
		});
	});

	it('rejects account fetch with an invalid token', async () => {
		sim.seed({ token: 'gho_correct' });
		await expect(fetchAccount('gho_wrong')).rejects.toThrow(/401/);
	});

	it('registers a signing key and the simulator records it', async () => {
		sim.seed({ token: 'gho_signing', signingKeys: [] });
		const result = await registerSigningKey(
			'gho_signing',
			'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 hezo',
			'Hezo signing key',
		);
		expect(result.status).toBe('created');
		if (result.status === 'created') {
			expect(result.id).toBeGreaterThan(0);
		}
		expect(sim.state.signingKeys).toHaveLength(1);
		expect(sim.state.signingKeys[0].title).toBe('Hezo signing key');
		expect(sim.state.signingKeys[0].key).toContain('ssh-ed25519');
	});

	it('treats a duplicate signing key as already_exists, not a failure', async () => {
		const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 hezo-duplicate';
		sim.seed({
			token: 'gho_dupe',
			signingKeys: [{ id: 99, title: 'pre-existing', key }],
		});
		const result = await registerSigningKey('gho_dupe', key, 'Hezo signing key');
		expect(result.status).toBe('already_exists');
		expect(sim.state.signingKeys).toHaveLength(1);
	});
});

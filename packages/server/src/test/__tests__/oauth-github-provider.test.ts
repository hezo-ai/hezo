import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	fetchAccount,
	pollDeviceFlow,
	registerSigningKey,
	startDeviceFlow,
} from '../../services/oauth/provider-github';
import { createGitHubSim, type GitHubSim } from '../helpers/github-sim';

let sim: GitHubSim;
let prevApi: string | undefined;
let prevOauth: string | undefined;
let prevClient: string | undefined;

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	prevOauth = process.env.GITHUB_OAUTH_BASE_URL;
	prevClient = process.env.GITHUB_OAUTH_CLIENT_ID;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	process.env.GITHUB_OAUTH_BASE_URL = prevOauth;
	process.env.GITHUB_OAUTH_CLIENT_ID = prevClient;
	await sim.destroy();
});

describe('GitHub OAuth device flow', () => {
	it('starts a device flow and surfaces the verification URL and user code to the caller', async () => {
		const started = await startDeviceFlow({ scopes: ['repo'] });
		expect(started.userCode).toMatch(/^USR-/);
		expect(started.verificationUri).toContain('/login/device');
		expect(started.deviceCode).toMatch(/^dev-/);
		expect(started.interval).toBeGreaterThan(0);
	});

	it('polls returning pending until the user approves, then returns the access token', async () => {
		const started = await startDeviceFlow();
		const first = await pollDeviceFlow(started.deviceCode);
		expect(first).toEqual({ status: 'pending', retryAfter: expect.any(Number) });

		sim.approveDeviceFlow(started.userCode, 'gho_after_approve');
		const second = await pollDeviceFlow(started.deviceCode);
		expect(second).toEqual({
			status: 'success',
			accessToken: 'gho_after_approve',
			scope: expect.any(String),
		});
	});

	it('returns failed for an unknown device_code', async () => {
		const result = await pollDeviceFlow('does-not-exist');
		expect(result).toEqual({ status: 'failed', error: 'expired_token' });
	});

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
		expect(result.id).toBeGreaterThan(0);
		expect(sim.state.signingKeys).toHaveLength(1);
		expect(sim.state.signingKeys[0].title).toBe('Hezo signing key');
		expect(sim.state.signingKeys[0].key).toContain('ssh-ed25519');
	});
});

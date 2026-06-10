import { encrypt } from '@hezo/server/test/helpers/app';
import { createGitHubSim, type GitHubSim } from '@hezo/server/test/helpers/github-sim';
import { screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

let sim: GitHubSim;
let prevApi: string | undefined;
const accessToken = 'gho_picker_test_token';
const ghOwner = 'octo-picker';
const collisionName = 'already-taken';

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	sim.seed({
		token: accessToken,
		user: { id: 9001, login: ghOwner, avatar_url: '', email: 'octo@picker' },
		repos: [
			{
				id: 7,
				name: collisionName,
				full_name: `${ghOwner}/${collisionName}`,
				owner: { login: ghOwner },
				private: true,
				default_branch: 'main',
				clone_url: `https://github.com/${ghOwner}/${collisionName}.git`,
				ssh_url: `git@github.com:${ghOwner}/${collisionName}.git`,
			},
		],
	});
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
});

async function seedGitHubOAuth(): Promise<string> {
	const { db, masterKeyManager } = getTestContext();
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key not available');
	const encrypted = encrypt(accessToken, key);

	const secretRes = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token', ARRAY['github.com'])
		 RETURNING id`,
		[`OAUTH_GITHUB_${Math.random().toString(16).slice(2, 10)}`, encrypted],
	);
	const connRes = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ('github', $1, $2, $3, ARRAY['repo','read:org','write:public_key'])
		 RETURNING id`,
		['9001', ghOwner, secretRes.rows[0].id],
	);
	return connRes.rows[0].id;
}

test('GITHUB_REPO_EXISTS surfaces a link-existing affordance that flips the modal', async () => {
	let projectSlug = '';
	const { user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Picker Project' });
			projectSlug = project.slug;
			await seedGitHubOAuth();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	const openModalButton = await screen.findByTestId('repo-setup-add', undefined, {
		timeout: 15_000,
	});
	await user.click(openModalButton);

	const modal = await screen.findByTestId('repo-picker-modal', undefined, { timeout: 5_000 });

	await user.click(await screen.findByTestId('repo-picker-tab-create'));

	const ownerSelect = await screen.findByTestId('repo-picker-owner');
	await waitFor(() => {
		expect((ownerSelect as HTMLSelectElement).value).toBe(ghOwner);
	});

	const nameInput = modal.querySelector('input[placeholder="my-new-service"]') as HTMLInputElement;
	await user.type(nameInput, collisionName);

	await user.click(await screen.findByTestId('repo-picker-submit'));

	const banner = await screen.findByTestId('repo-picker-exists-banner', undefined, {
		timeout: 10_000,
	});
	expect(banner.textContent).toContain(`${ghOwner}/${collisionName}`);
	expect(banner.textContent).toContain('already exists');

	await user.click(await screen.findByTestId('repo-picker-link-existing'));

	await screen.findByTestId(`repo-picker-row-${ghOwner}/${collisionName}`, undefined, {
		timeout: 10_000,
	});

	const searchInput = modal.querySelector(
		'input[placeholder="Filter by name…"]',
	) as HTMLInputElement;
	expect(searchInput.value).toBe(collisionName);

	const row = await screen.findByTestId(`repo-picker-row-${ghOwner}/${collisionName}`);
	expect(row.className).toContain('bg-bg-subtle');

	expect(screen.queryByTestId('repo-picker-exists-banner')).toBeNull();
});

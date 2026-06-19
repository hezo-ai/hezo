// Wizard-flow coverage for the Phase 13 repo-setup picker: the successful
// "Link existing" and "Create new" paths against the GitHub simulator, plus
// the designated-repo lock (no delete affordance) on the project settings
// page. Component tier per the decision tree — pure form/dialog/mutation
// behavior, no real layout, viewport, or WebSocket dependency.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encrypt } from '@hezo/server/test/helpers/app';
import { createGitHubSim, type GitHubSim } from '@hezo/server/test/helpers/github-sim';
import { screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

let sim: GitHubSim;
let prevApi: string | undefined;
const accessToken = 'gho_picker_flows_token';
const ghOwner = 'octo-flows';

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	sim.seed({
		token: accessToken,
		user: { id: 9100, login: ghOwner, avatar_url: '', email: 'octo@flows' },
		repos: [
			{
				id: 11,
				name: 'billing-service',
				full_name: `${ghOwner}/billing-service`,
				owner: { login: ghOwner },
				private: true,
				default_branch: 'main',
				clone_url: `https://github.com/${ghOwner}/billing-service.git`,
				ssh_url: `git@github.com:${ghOwner}/billing-service.git`,
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
		['9100', ghOwner, secretRes.rows[0].id],
	);
	return connRes.rows[0].id;
}

// POST /repos clones over SSH after the insert; the test app has no
// SshAgentServer, so emulate an existing clone (repo-sync skips dirs that
// already contain .git) and mark the container running so the post-designation
// container auto-start is a no-op. Keeps the success path quiet and green.
async function neutralizeRepoSideEffects(teamId: string, projectId: string, repoName: string) {
	const { db, dataDir } = getTestContext();
	const gitDir = join(
		dataDir,
		'teams',
		teamId,
		'projects',
		projectId,
		'workspace',
		repoName,
		'.git',
	);
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
	await db.query(
		`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
		[projectId],
	);
}

async function openRepoPicker(user: Awaited<ReturnType<typeof renderApp>>['user']) {
	const openModalButton = await screen.findByTestId('repo-setup-add', undefined, {
		timeout: 15_000,
	});
	await user.click(openModalButton);
	await screen.findByTestId('repo-picker-modal', undefined, { timeout: 5_000 });
	const ownerSelect = await screen.findByTestId('repo-picker-owner');
	await waitFor(() => {
		expect((ownerSelect as HTMLSelectElement).value).toBe(ghOwner);
	});
}

test('link-existing flow links the repo and auto-designates the first repo', async () => {
	let projectSlug = '';
	const { user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Flows Link Project' });
			projectSlug = project.slug;
			await seedGitHubOAuth();
			await neutralizeRepoSideEffects(ws.team.id, project.id, 'billing-service');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await openRepoPicker(user);

	await user.click(screen.getByTestId('repo-picker-tab-link'));

	await user.click(
		await screen.findByTestId(`repo-picker-row-${ghOwner}/billing-service`, undefined, {
			timeout: 10_000,
		}),
	);
	await user.click(screen.getByTestId('repo-picker-submit'));

	await waitFor(() => expect(screen.queryByTestId('repo-picker-modal')).toBeNull(), {
		timeout: 10_000,
	});

	const link = await screen.findByTestId('repo-link-billing-service', undefined, {
		timeout: 10_000,
	});
	expect(link.textContent).toBe(`${ghOwner}/billing-service`);
	await screen.findByText('Designated');
	await screen.findByTestId('repo-locked-billing-service');
	expect(screen.queryByTestId('repo-delete-billing-service')).toBeNull();
});

test('create-new flow creates the repo on GitHub and auto-designates it', async () => {
	let projectSlug = '';
	const { user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Flows Create Project' });
			projectSlug = project.slug;
			await seedGitHubOAuth();
			await neutralizeRepoSideEffects(ws.team.id, project.id, 'fresh-service');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await openRepoPicker(user);

	// "Create new" is the default tab, so the name input is visible immediately.
	const modal = screen.getByTestId('repo-picker-modal');
	const nameInput = modal.querySelector('input[placeholder="my-new-service"]') as HTMLInputElement;
	await user.type(nameInput, 'fresh-service');
	await user.click(screen.getByTestId('repo-picker-submit'));

	await waitFor(() => expect(screen.queryByTestId('repo-picker-modal')).toBeNull(), {
		timeout: 10_000,
	});

	const link = await screen.findByTestId('repo-link-fresh-service', undefined, {
		timeout: 10_000,
	});
	expect(link.textContent).toBe(`${ghOwner}/fresh-service`);
	await screen.findByText('Designated');
	await screen.findByTestId('repo-locked-fresh-service');

	// The repo really got created upstream, not just recorded locally.
	expect(sim.state.repos.some((r) => r.full_name === `${ghOwner}/fresh-service`)).toBe(true);
});

test('designated repo shows a lock with no delete affordance; extras stay deletable', async () => {
	let projectSlug = '';
	const { user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Flows Lock Project' });
			projectSlug = project.slug;
			await seedGitHubOAuth();

			const { db } = getTestContext();
			const designated = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, repo_identifier, host_type)
				 VALUES ($1, $2, 'github') RETURNING id`,
				[project.id, `${ghOwner}/main-repo`],
			);
			await db.query(
				`INSERT INTO repos (project_id, repo_identifier, host_type)
				 VALUES ($1, $2, 'github')`,
				[project.id, `${ghOwner}/extra-repo`],
			);
			await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
				designated.rows[0].id,
				project.id,
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await screen.findByTestId('repo-locked-main-repo', undefined, { timeout: 15_000 });
	await screen.findByText('Designated');
	expect(screen.queryByTestId('repo-delete-main-repo')).toBeNull();

	await user.click(await screen.findByTestId('repo-delete-extra-repo'));
	await waitFor(() => expect(screen.queryByText(`${ghOwner}/extra-repo`)).toBeNull(), {
		timeout: 10_000,
	});

	// The designated repo survives, still locked.
	screen.getByTestId('repo-locked-main-repo');
	expect(screen.queryByTestId('repo-delete-main-repo')).toBeNull();
});

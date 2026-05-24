import { expect, test } from '@playwright/test';
import { authenticate, createProjectAndClearPlanning, createTeamWithAgents } from './helpers';

test('run comment shows created tickets as links to their pages', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Spawned Tickets Project',
		description: 'Test project.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Parent With Spawns',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const runId = '99999999-9999-9999-9999-999999999999';
	const spawnedA = {
		id: '11111111-1111-1111-1111-111111111111',
		identifier: 'SPAWN-900',
		title: 'Refactor auth',
		project_slug: project.slug,
	};
	const spawnedB = {
		id: '22222222-2222-2222-2222-222222222222',
		identifier: 'SPAWN-901',
		title: 'Add tests for X',
		project_slug: project.slug,
	};

	const runComment = {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: captain.id, agent_title: 'Captain' },
		chosen_option: null,
		created_at: new Date().toISOString(),
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: captain.id,
	};

	await page.route(`**/api/teams/*/tasks/*/comments**`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	const runResponse = {
		id: runId,
		member_id: captain.id,
		team_id: team.id,
		task_id: task.id,
		task_identifier: 'PARENT-1',
		task_title: 'Parent With Spawns',
		project_id: project.id,
		status: 'succeeded',
		started_at: new Date().toISOString(),
		finished_at: new Date().toISOString(),
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: 'done',
		working_dir: null,
		created_tasks: [spawnedA, spawnedB],
	};

	await page.route(`**/api/teams/*/agents/${captain.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const createdSection = runCommentEl.getByTestId('run-comment-created-tasks');
	await expect(createdSection).toBeVisible({ timeout: 20_000 });
	await expect(createdSection).toContainText('Created tickets');

	const linkA = createdSection.getByRole('link', {
		name: `${spawnedA.identifier} — ${spawnedA.title}`,
	});
	await expect(linkA).toHaveAttribute(
		'href',
		`/teams/${team.slug}/projects/${project.slug}/tasks/${spawnedA.identifier.toLowerCase()}`,
	);
	const linkB = createdSection.getByRole('link', {
		name: `${spawnedB.identifier} — ${spawnedB.title}`,
	});
	await expect(linkB).toHaveAttribute(
		'href',
		`/teams/${team.slug}/projects/${project.slug}/tasks/${spawnedB.identifier.toLowerCase()}`,
	);
});

test('run comment omits created tickets section when list is empty', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Empty Project',
		description: 'Test project.',
	});
	const project = ((await projectRes.json()) as { data: { id: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Parent No Spawns',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const runId = '99999999-9999-9999-9999-000000000002';
	const runComment = {
		id: 'aaaa0000-0000-0000-0000-000000000002',
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: captain.id, agent_title: 'Captain' },
		chosen_option: null,
		created_at: new Date().toISOString(),
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: captain.id,
	};

	await page.route(`**/api/teams/*/tasks/*/comments**`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	const runResponse = {
		id: runId,
		member_id: captain.id,
		team_id: team.id,
		task_id: task.id,
		task_identifier: 'PARENT-2',
		task_title: 'Parent No Spawns',
		project_id: project.id,
		status: 'succeeded',
		started_at: new Date().toISOString(),
		finished_at: new Date().toISOString(),
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: 'done',
		working_dir: null,
		created_tasks: [],
	};

	await page.route(`**/api/teams/*/agents/${captain.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });
	await expect(runCommentEl.getByTestId('run-comment-created-tasks')).toHaveCount(0);
});

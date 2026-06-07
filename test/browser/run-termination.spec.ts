import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName } from './helpers';

interface MockSetup {
	teamId: string;
	teamSlug: string;
	projectSlug: string;
	agentId: string;
	agentSlug: string;
	taskId: string;
}

async function setupTask(
	page: Page,
	team: { id: string; slug: string },
	token: string,
	agents: Array<{ id: string; slug: string }>,
): Promise<MockSetup> {
	const headers = { Authorization: `Bearer ${token}` };

	const agent = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.slug, token, {
		name: uniqueName('Terminate Run Project'),
		description: 'Test project.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: { project_id: project.id, title: 'Terminate Me', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	return {
		teamId: team.id,
		teamSlug: team.slug,
		projectSlug: project.slug,
		agentId: agent.id,
		agentSlug: agent.slug,
		taskId: task.id,
	};
}

const FAKE_RUN_ID = 'cccc0000-0000-0000-0000-000000000123';

function makeRunComment(setup: MockSetup) {
	return {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		task_id: setup.taskId,
		content_type: 'run',
		content: {
			run_id: FAKE_RUN_ID,
			agent_id: setup.agentId,
			agent_title: 'Captain',
		},
		chosen_option: null,
		created_at: '2026-05-25T11:30:40Z',
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: setup.agentId,
	};
}

function makeRunRow(setup: MockSetup, status: 'running' | 'cancelled' | 'succeeded') {
	const startedAt = '2026-05-25T11:30:40Z';
	return {
		id: FAKE_RUN_ID,
		member_id: setup.agentId,
		team_id: setup.teamId,
		wakeup_id: null,
		task_id: setup.taskId,
		task_identifier: 'TR-1',
		task_title: 'Terminate Me',
		project_id: null,
		project_slug: null,
		status,
		started_at: startedAt,
		finished_at: status === 'running' ? null : '2026-05-25T11:30:45Z',
		exit_code: status === 'succeeded' ? 0 : status === 'cancelled' ? -1 : null,
		error: status === 'cancelled' ? 'Terminated by user' : null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: null,
		invocation_command: null,
		log_text: '[synthetic] running',
		working_dir: null,
		trigger_source: 'on_demand',
		trigger_payload: null,
		trigger_comment_id: null,
		trigger_actor_member_id: null,
		trigger_actor_slug: null,
		trigger_actor_title: null,
		trigger_comment_task_id: null,
		trigger_comment_task_identifier: null,
		trigger_comment_project_slug: null,
		created_tasks: [],
	};
}

async function mockRunningRun(page: Page, setup: MockSetup) {
	await page.route('**/api/projects/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [makeRunComment(setup)] }),
		});
	});

	await page.route(`**/api/projects/*/agents/*/heartbeat-runs/${FAKE_RUN_ID}`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: makeRunRow(setup, 'running') }),
		});
	});
}

test('terminate button renders on mobile viewport', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	await page.setViewportSize({ width: 375, height: 800 });
	const setup = await setupTask(
		page,
		sharedWorkspace.team,
		sharedWorkspace.token,
		sharedWorkspace.agents,
	);
	await mockRunningRun(page, setup);

	await page.goto(`/projects/${setup.projectSlug}/tasks/${setup.taskId}`);

	const terminateButton = page.getByTestId('terminate-run-button').first();
	await expect(terminateButton).toBeVisible({ timeout: 20_000 });
});

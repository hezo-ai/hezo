import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName } from './helpers';

interface MockSetup {
	teamId: string;
	teamSlug: string;
	agentId: string;
	agentSlug: string;
	taskId: string;
}

async function mockRunFailedComment(page: Page, setup: MockSetup): Promise<void> {
	const failedComment = {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		task_id: setup.taskId,
		content_type: 'system',
		content: {
			kind: 'run_failed',
			run_id: 'bbbb0000-0000-0000-0000-000000000777',
			status: 'timed_out',
			error: 'The operation timed out.',
			member_id: setup.agentId,
			agent_slug: setup.agentSlug,
		},
		chosen_option: null,
		created_at: '2026-05-20T11:30:40Z',
		author_type: 'board',
		author_name: 'Board',
		author_member_id: null,
	};

	await page.route('**/api/teams/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [failedComment] }),
		});
	});
}

async function setupTask(
	page: Page,
	team: { id: string; slug: string },
	token: string,
	agents: Array<{ id: string; slug: string }>,
): Promise<MockSetup> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const agent = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Run Failed Project'),
		description: 'Test project.',
	});
	const project = ((await projectRes.json()) as { data: { id: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Run Failed Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	return {
		teamId: team.id,
		teamSlug: team.slug,
		agentId: agent.id,
		agentSlug: agent.slug,
		taskId: task.id,
	};
}

test('task page renders run_failed system comment with agent link and error', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const setup = await setupTask(
		page,
		sharedWorkspace.team,
		sharedWorkspace.token,
		sharedWorkspace.agents,
	);
	await mockRunFailedComment(page, setup);

	await page.goto(`/teams/${setup.teamSlug}/tasks/${setup.taskId}`);

	const failureComment = page.getByTestId('run-failed-comment');
	await expect(failureComment).toBeVisible({ timeout: 20_000 });
	await expect(failureComment).toContainText('timed out');
	await expect(failureComment).toContainText('The operation timed out.');
	await expect(failureComment).toContainText('Waking agent to retry.');

	const agentLink = failureComment.getByTestId('run-failed-agent');
	await expect(agentLink).toBeVisible();
	await expect(agentLink).toContainText(`@${setup.agentSlug}`);
	await expect(agentLink).toHaveAttribute(
		'href',
		new RegExp(`/teams/${setup.teamSlug}/agents/${setup.agentSlug}$`),
	);
});

test('run_failed comment renders correctly on mobile viewport', async ({
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
	await mockRunFailedComment(page, setup);

	await page.goto(`/teams/${setup.teamSlug}/tasks/${setup.taskId}`);

	const failureComment = page.getByTestId('run-failed-comment');
	await expect(failureComment).toBeVisible({ timeout: 20_000 });
	await expect(failureComment).toContainText('timed out');
	await expect(failureComment).toContainText('The operation timed out.');

	const agentLink = failureComment.getByTestId('run-failed-agent');
	await expect(agentLink).toBeVisible();
	await expect(agentLink).toContainText(`@${setup.agentSlug}`);
});

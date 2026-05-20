import { expect, type Page, test } from '@playwright/test';
import { authenticate, createTeamWithAgents } from './helpers';

interface MockSetup {
	teamId: string;
	teamSlug: string;
	agentId: string;
	agentSlug: string;
	issueId: string;
}

async function mockRunFailedComment(page: Page, setup: MockSetup): Promise<void> {
	const failedComment = {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		issue_id: setup.issueId,
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

	await page.route('**/api/teams/*/issues/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [failedComment] }),
		});
	});
}

async function setupIssue(page: Page): Promise<MockSetup> {
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const agent = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Run Failed Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string } }).data;

	const issueRes = await page.request.post(`/api/teams/${team.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Run Failed Issue', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	return {
		teamId: team.id,
		teamSlug: team.slug,
		agentId: agent.id,
		agentSlug: agent.slug,
		issueId: issue.id,
	};
}

test('issue page renders run_failed system comment with agent link and error', async ({ page }) => {
	await authenticate(page);
	const setup = await setupIssue(page);
	await mockRunFailedComment(page, setup);

	await page.goto(`/teams/${setup.teamSlug}/issues/${setup.issueId}`);

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

test('run_failed comment renders correctly on mobile viewport', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const setup = await setupIssue(page);
	await mockRunFailedComment(page, setup);

	await page.goto(`/teams/${setup.teamSlug}/issues/${setup.issueId}`);

	const failureComment = page.getByTestId('run-failed-comment');
	await expect(failureComment).toBeVisible({ timeout: 20_000 });
	await expect(failureComment).toContainText('timed out');
	await expect(failureComment).toContainText('The operation timed out.');

	const agentLink = failureComment.getByTestId('run-failed-agent');
	await expect(agentLink).toBeVisible();
	await expect(agentLink).toContainText(`@${setup.agentSlug}`);
});

import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	uniqueName,
	waitForAgentIdle,
	waitForPageLoad,
} from './helpers';

test.describe('Mention handoff', () => {
	async function setup(
		page: import('@playwright/test').Page,
		team: { id: string; slug: string },
		token: string,
		agents: Array<{ id: string; slug: string; title: string }>,
	) {
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: uniqueName('Handoff Project'),
			description: 'Test project.',
		});
		const project = ((await projRes.json()) as any).data;

		const captain = agents.find((a) => a.slug === 'captain');
		const architect = agents.find((a) => a.slug === 'architect');
		if (!captain || !architect) throw new Error('Captain and architect agents required');

		const ceoTaskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Roadmap ticket',
				assignee_id: captain.id,
			},
		});
		const ceoTask = ((await ceoTaskRes.json()) as any).data;

		const archTaskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Architecture spec (pre-existing)',
				assignee_id: architect.id,
			},
		});
		const architectTask = ((await archTaskRes.json()) as any).data;

		// Drain assignment-driven wakeups so test interactions aren't racing
		// agent runs posting system comments onto the same threads.
		await Promise.all([
			waitForAgentIdle(page, team.id, captain.id, token),
			waitForAgentIdle(page, team.id, architect.id, token),
		]);

		return { team, token, headers, captain, architect, ceoTask, architectTask };
	}

	test('posting an @architect mention in a comment renders as a link to the architect page', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, architect, ceoTask } = await setup(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents as Array<{ id: string; slug: string; title: string }>,
		);

		await page.goto(`/teams/${team.slug}/tasks/${ceoTask.id}`);
		await waitForPageLoad(page);

		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeVisible({ timeout: 20000 });
		await composer.fill(`@${architect.slug} please update the spec.`);
		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		const comment = page
			.getByTestId('text-comment-body')
			.filter({ hasText: 'please update the spec' })
			.first();
		await expect(comment).toBeVisible({ timeout: 15000 });

		const mentionLink = comment.getByTestId('agent-mention-link');
		await expect(mentionLink).toHaveText(`@${architect.slug}`);
		await expect(mentionLink).toHaveAttribute(
			'href',
			`/teams/${team.slug}/agents/${architect.slug}`,
		);
	});

	test('comment with @mention inside a fenced code block does not render a mention link', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, architect, ceoTask, headers } = await setup(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents as Array<{ id: string; slug: string; title: string }>,
		);

		const body = `Here is the template we discussed:\n\`\`\`\n@${architect.slug}\n\`\`\`\nThat's it.`;
		await page.request.post(`/api/teams/${team.id}/tasks/${ceoTask.id}/comments`, {
			headers,
			data: { content: { text: body } },
		});

		await page.goto(`/teams/${team.slug}/tasks/${ceoTask.id}`);
		await waitForPageLoad(page);

		const comment = page
			.getByTestId('text-comment-body')
			.filter({ hasText: 'template we discussed' })
			.first();
		await expect(comment).toBeVisible({ timeout: 15000 });

		// The agent slug appears verbatim in the code block but must NOT be linkified.
		await expect(comment.locator(`a[href*="/agents/${architect.slug}"]`)).toHaveCount(0);
	});

	test('architect agent page is reachable via the mention link from a comment', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, architect, ceoTask, headers } = await setup(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents as Array<{ id: string; slug: string; title: string }>,
		);

		await page.request.post(`/api/teams/${team.id}/tasks/${ceoTask.id}/comments`, {
			headers,
			data: { content: { text: `@${architect.slug} heads up` } },
		});

		await page.goto(`/teams/${team.slug}/tasks/${ceoTask.id}`);
		await waitForPageLoad(page);

		await page.getByTestId('agent-mention-link').first().click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/agents/${architect.slug}(/|$)`));
		await expect(page.getByTestId('agent-summary')).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('heading', { name: architect.title })).toBeVisible();
	});

	test('mentioning multiple agents in one comment renders all mentions', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, captain, architect, ceoTask, headers } = await setup(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents as Array<{ id: string; slug: string; title: string }>,
		);

		await page.request.post(`/api/teams/${team.id}/tasks/${ceoTask.id}/comments`, {
			headers,
			data: {
				content: { text: `cc @${architect.slug} and @${captain.slug} for visibility` },
			},
		});

		await page.goto(`/teams/${team.slug}/tasks/${ceoTask.id}`);
		await waitForPageLoad(page);

		const comment = page
			.getByTestId('text-comment-body')
			.filter({ hasText: 'for visibility' })
			.first();
		await expect(comment).toBeVisible({ timeout: 15000 });
		await expect(comment.locator(`a[href*="/agents/${architect.slug}"]`)).toHaveCount(1, {
			timeout: 15000,
		});
		await expect(comment.locator(`a[href*="/agents/${captain.slug}"]`)).toHaveCount(1, {
			timeout: 15000,
		});
	});

	test('passive @@<slug> renders a clickable chip but creates no mention wakeup', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, architect, captain, ceoTask, headers } = await setup(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents as Array<{ id: string; slug: string; title: string }>,
		);

		await page.request.post(`/api/teams/${team.id}/tasks/${ceoTask.id}/comments`, {
			headers,
			data: {
				content: { text: `Plan: BE-2 → @@${architect.slug}, BE-3 → @@${captain.slug}.` },
			},
		});

		await page.goto(`/teams/${team.slug}/tasks/${ceoTask.id}`);
		await waitForPageLoad(page);

		const comment = page.getByTestId('text-comment-body').filter({ hasText: 'Plan:' }).first();
		await expect(comment).toBeVisible({ timeout: 15000 });

		const archChip = comment.locator(`a[href*="/agents/${architect.slug}"]`);
		await expect(archChip).toHaveCount(1, { timeout: 15000 });
		await expect(archChip).toHaveAttribute('data-mention-passive', 'true');
		await expect(archChip).toHaveText(`@${architect.slug}`);

		const captChip = comment.locator(`a[href*="/agents/${captain.slug}"]`);
		await expect(captChip).toHaveCount(1);
		await expect(captChip).toHaveAttribute('data-mention-passive', 'true');
	});
});

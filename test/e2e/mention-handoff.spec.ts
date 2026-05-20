import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

test.describe('Mention handoff', () => {
	async function setup(page: import('@playwright/test').Page) {
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/teams/${team.id}/projects`, {
			headers,
			data: { name: 'Handoff Project', description: 'Test project.' },
		});
		const project = ((await projRes.json()) as any).data;

		const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as any).data as Array<{
			id: string;
			slug: string;
			title: string;
		}>;
		const captain = agents.find((a) => a.slug === 'captain');
		const architect = agents.find((a) => a.slug === 'architect');
		if (!captain || !architect) throw new Error('Captain and architect agents required');

		const ceoIssueRes = await page.request.post(`/api/teams/${team.id}/issues`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Roadmap ticket',
				assignee_id: captain.id,
			},
		});
		const ceoIssue = ((await ceoIssueRes.json()) as any).data;

		const archIssueRes = await page.request.post(`/api/teams/${team.id}/issues`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Architecture spec (pre-existing)',
				assignee_id: architect.id,
			},
		});
		const architectIssue = ((await archIssueRes.json()) as any).data;

		return { team, token, headers, captain, architect, ceoIssue, architectIssue };
	}

	test('posting an @architect mention in a comment renders as a link to the architect page', async ({
		page,
	}) => {
		await authenticate(page);
		const { team, architect, ceoIssue } = await setup(page);

		await page.goto(`/teams/${team.slug}/issues/${ceoIssue.id}`);
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
		page,
	}) => {
		await authenticate(page);
		const { team, architect, ceoIssue, headers } = await setup(page);

		const body = `Here is the template we discussed:\n\`\`\`\n@${architect.slug}\n\`\`\`\nThat's it.`;
		await page.request.post(`/api/teams/${team.id}/issues/${ceoIssue.id}/comments`, {
			headers,
			data: { content: { text: body } },
		});

		await page.goto(`/teams/${team.slug}/issues/${ceoIssue.id}`);
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
		page,
	}) => {
		await authenticate(page);
		const { team, architect, ceoIssue, headers } = await setup(page);

		await page.request.post(`/api/teams/${team.id}/issues/${ceoIssue.id}/comments`, {
			headers,
			data: { content: { text: `@${architect.slug} heads up` } },
		});

		await page.goto(`/teams/${team.slug}/issues/${ceoIssue.id}`);
		await waitForPageLoad(page);

		await page.getByTestId('agent-mention-link').first().click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/agents/${architect.slug}(/|$)`));
		await expect(page.getByTestId('agent-summary')).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('heading', { name: architect.title })).toBeVisible();
	});

	test('mentioning multiple agents in one comment renders all mentions', async ({ page }) => {
		await authenticate(page);
		const { team, captain, architect, ceoIssue, headers } = await setup(page);

		await page.request.post(`/api/teams/${team.id}/issues/${ceoIssue.id}/comments`, {
			headers,
			data: {
				content: { text: `cc @${architect.slug} and @${captain.slug} for visibility` },
			},
		});

		await page.goto(`/teams/${team.slug}/issues/${ceoIssue.id}`);
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
});

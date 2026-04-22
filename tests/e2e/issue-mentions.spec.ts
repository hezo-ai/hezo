import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

test('issue @-mention renders as a tooltip-ed link and navigates to the target issue', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const projA = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Mention Source',
		description: 'Source project for mention test.',
	});
	const projB = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Mention Target',
		description: 'Target project for mention test.',
	});

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo');
	if (!ceo) throw new Error('CEO agent not found');

	const targetRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: {
			project_id: projB.id,
			title: 'Target issue title goes here',
			assignee_id: ceo.id,
		},
	});
	const target = (
		(await targetRes.json()) as { data: { id: string; identifier: string; title: string } }
	).data;

	const sourceRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: {
			project_id: projA.id,
			title: 'Source issue',
			description: `See also @${target.identifier} for related work.`,
			assignee_id: ceo.id,
		},
	});
	const source = ((await sourceRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(
		`/companies/${company.slug}/projects/${projA.slug}/issues/${source.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Source issue' })).toBeVisible();

	const mentionLink = page.getByTestId('issue-mention-link').first();
	await expect(mentionLink).toBeVisible();
	await expect(mentionLink).toContainText(`@${target.identifier}`);

	await mentionLink.hover();
	await expect(page.getByText(target.title, { exact: true })).toBeVisible();

	await mentionLink.click();
	await expect(page.getByRole('heading', { name: target.title })).toBeVisible();
	const targetPath = `/companies/${company.slug}/projects/${projB.slug}/issues/${target.identifier.toLowerCase()}`;
	expect(new URL(page.url()).pathname).toBe(targetPath);
});

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName } from './helpers';

test('bare kb and project-doc references render as tooltip-ed links and navigate to the doc editor', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}` };
	const json = { ...headers, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Doc Mention Project'),
		description: 'Project for doc-mention e2e test.',
	});

	const kbSuffix = Math.random().toString(36).slice(2, 8);
	const kbTitle = `Onboarding Guide ${kbSuffix}`;
	const kbSlug = `onboarding-guide-${kbSuffix}.md`;
	const docFilename = `runbook-${kbSuffix}.md`;

	await page.request.post(`/api/teams/${team.id}/kb-docs`, {
		headers: json,
		data: { title: kbTitle, content: 'Hello onboarding world' },
	});

	await page.request.put(`/api/teams/${team.id}/projects/${project.slug}/docs/${docFilename}`, {
		headers: json,
		data: { content: 'Runbook step A.\nRunbook step B.' },
	});

	const captain = agents.find((a) => a.slug === 'captain');
	if (!captain) throw new Error('Captain agent not found');

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers: json,
		data: {
			project_id: project.id,
			title: 'Doc mention host task',
			description: `See ${kbSlug} and ${docFilename} for context.`,
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(
		`/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Doc mention host task' })).toBeVisible();

	const kbLink = page.getByTestId('kb-mention-link').first();
	await expect(kbLink).toBeVisible();
	await expect(kbLink).toContainText(kbSlug);
	await kbLink.hover();
	await expect(page.getByText(kbTitle, { exact: true }).first()).toBeVisible();

	const docLink = page.getByTestId('doc-mention-link').first();
	await expect(docLink).toBeVisible();
	await expect(docLink).toContainText(docFilename);

	await kbLink.click();
	await expect(page).toHaveURL(
		new RegExp(`/teams/${team.slug}/kb\\?slug=onboarding-guide-${kbSuffix}(\\.md|%2Emd)`),
	);
});

test('mention picker opens on @ and inserts the selected handle', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}` };
	const json = { ...headers, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Picker Project'),
		description: 'Project for mention-picker e2e.',
	});

	const kbSuffix = Math.random().toString(36).slice(2, 8);
	const kbTitle = `Picker Doc ${kbSuffix}`;
	const kbSlug = `picker-doc-${kbSuffix}.md`;
	await page.request.post(`/api/teams/${team.id}/kb-docs`, {
		headers: json,
		data: { title: kbTitle, content: 'Picker content.' },
	});

	const captain = agents.find((a) => a.slug === 'captain');
	if (!captain) throw new Error('Captain agent not found');

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers: json,
		data: { project_id: project.id, title: 'Picker host', assignee_id: captain.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(
		`/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Picker host' })).toBeVisible();

	const commentBox = page.getByPlaceholder('Add a comment...');
	await commentBox.click();
	await commentBox.type(`Reference @picker-doc-${kbSuffix.slice(0, 3)}`);

	const picker = page.getByTestId('mention-picker');
	await expect(picker).toBeVisible();

	const option = page.getByTestId('mention-option-kb').first();
	await expect(option).toContainText(kbTitle);
	await option.click();

	await expect(commentBox).toHaveValue(new RegExp(`(?<!@)${kbSlug.replace(/\./g, '\\.')} `));
});

test('rendered markdown autolinks only real entities and leaves look-alikes as text', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}` };
	const json = { ...headers, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Mixed Mentions'),
		description: 'Host project for mixed-mention e2e.',
	});

	const kbSuffix = Math.random().toString(36).slice(2, 8);
	const kbSlug = `coding-standards-${kbSuffix}.md`;
	const docFilename = `spec-${kbSuffix}.md`;

	await page.request.post(`/api/teams/${team.id}/kb-docs`, {
		headers: json,
		data: {
			title: `Coding Standards ${kbSuffix}`,
			slug: kbSlug,
			content: 'Prefer early returns.',
		},
	});
	await page.request.put(`/api/teams/${team.id}/projects/${project.slug}/docs/${docFilename}`, {
		headers: json,
		data: { content: 'Spec body.' },
	});

	const captain = agents.find((a) => a.slug === 'captain');
	if (!captain) throw new Error('Captain agent not found');

	const targetTaskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers: json,
		data: { project_id: project.id, title: 'Target for mixed mentions', assignee_id: captain.id },
	});
	const targetTask = (
		(await targetTaskRes.json()) as {
			data: { id: string; identifier: string };
		}
	).data;

	const body = [
		`See ${targetTask.identifier} and ${docFilename} and ${kbSlug} with @captain.`,
		`Look-alikes that must stay plain text: UTF-8, ${targetTask.identifier}x, \`${targetTask.identifier}\` and \`${docFilename}\`.`,
	].join('\n\n');

	const hostRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers: json,
		data: {
			project_id: project.id,
			title: 'Host for mixed mentions',
			description: body,
			assignee_id: captain.id,
		},
	});
	const host = ((await hostRes.json()) as { data: { identifier: string } }).data;

	await page.goto(
		`/teams/${team.slug}/projects/${project.slug}/tasks/${host.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Host for mixed mentions' })).toBeVisible();

	await expect(page.getByTestId('task-mention-link')).toHaveCount(1);
	await expect(page.getByTestId('doc-mention-link')).toHaveCount(1);
	await expect(page.getByTestId('kb-mention-link')).toHaveCount(1);
	await expect(page.getByTestId('agent-mention-link')).toHaveCount(1);
});

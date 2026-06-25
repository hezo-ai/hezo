// Coverage for components/markdown-prose.tsx mention-link rendering branches the
// existing comment / ceo-chat specs don't reach: the KB-doc (skill) mention link,
// the @admin inbox mention, the passive @@agent mention attribute + bare-slug
// label, and the plain external-link fallback. Driven through the real task-
// comment surface so the resolve hooks populate the mention maps against the real
// backend. Component tier — pure render logic, no layout/WS.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function seedSkill(name: string, slug: string): Promise<void> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/skills', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, slug, content: `# ${name}\nbody`, description: 'A KB doc.' }),
	});
	if (res.status !== 201) throw new Error(`seed skill failed: ${res.status}`);
}

test('a bare doc-style reference resolving to a skill renders a KB-doc link to the Skills page', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			// A doc-style filename candidate (`runbook.md`) resolves to a skill only
			// when a skill carries that exact slug — the extracted kb candidate keeps
			// the extension, so the skill slug must too.
			await seedSkill('Runbook', 'runbook.md');
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'KB Mention Project' });
			const task = await seedTask(ws, project, { title: 'KB Mention Task' });
			// Bare (not backticked — code spans are stripped from candidate extraction).
			await seedComment(ws, task, 'Follow runbook.md when deploying.');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// findByTestId auto-waits for the docs/resolve roundtrip + re-render.
	const link = (await findByTestId('kb-mention-link', undefined, {
		timeout: 20_000,
	})) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('/settings/skills');
	expect(link.textContent).toContain('runbook.md');
});

test('@admin in a comment renders an inbox mention link scoped to the project', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Admin Mention Project' });
			const task = await seedTask(ws, project, { title: 'Admin Mention Task' });
			await seedComment(ws, task, 'Hey @admin can you confirm the budget?');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const link = (await findByTestId('admin-mention-link', undefined, {
		timeout: 20_000,
	})) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(`/projects/${seeded.projectSlug}/inbox`);
	expect(link.textContent).toContain('@admin');
});

test('a plain external markdown link renders as a new-tab anchor (the non-mention fallback)', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'External Link Project' });
			const task = await seedTask(ws, project, { title: 'External Link Task' });
			await seedComment(ws, task, 'Docs live at [the site](https://example.com/docs).');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText(/Docs live at/, undefined, { timeout: 20_000 });
	const anchor = Array.from(container.querySelectorAll('a')).find(
		(a) => a.getAttribute('href') === 'https://example.com/docs',
	) as HTMLAnchorElement | undefined;
	expect(anchor).toBeTruthy();
	expect(anchor?.getAttribute('target')).toBe('_blank');
	expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
	expect(anchor?.textContent).toBe('the site');
});

test('a passive @@agent mention renders the bare slug as a passive-flagged link', async () => {
	const seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Passive Mention Project' });
			const task = await seedTask(ws, project, { title: 'Passive Mention Task' });
			const agentSlug = ws.agents.find((a) => a.slug === 'captain')?.slug ?? ws.agents[0].slug;
			// `@@slug` is a *passive* mention — links to the agent but renders the bare
			// slug (no leading @) and carries data-mention-passive.
			await seedComment(ws, task, `Context for @@${agentSlug} without pinging them.`);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = agentSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText(/without pinging them/, undefined, { timeout: 20_000 });
	const passiveLink = await waitFor(() => {
		const el = container.querySelector(
			'[data-testid="agent-mention-link"][data-mention-passive="true"]',
		) as HTMLAnchorElement | null;
		if (!el) throw new Error('passive mention link not yet resolved');
		return el;
	});
	expect(passiveLink.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`,
	);
	// Passive form drops the leading "@" in the visible label.
	expect(passiveLink.textContent).toBe(seeded.agentSlug);
});

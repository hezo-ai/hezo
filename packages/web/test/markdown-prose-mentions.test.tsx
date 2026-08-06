// Coverage for components/markdown-prose.tsx mention-link rendering branches the
// existing comment / chat specs don't reach: the KB-doc (skill) mention link,
// the @admin inbox mention, the passive @@agent mention attribute + bare-slug
// label, and the plain external-link fallback. Driven through the real task-
// comment surface so the resolve hooks populate the mention maps against the real
// backend. Component tier — pure render logic, no layout/WS.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

/**
 * Seed a "source" task whose description references a "target" task by identifier,
 * put the target at `targetStatus`, render the source's task page, and return the
 * resolved `task-mention-link` element for the target. The description field runs
 * through markdown-prose, so the reference linkifies once `/tasks/resolve` returns.
 */
async function renderTaskMention(targetStatus: string): Promise<HTMLAnchorElement> {
	let projSlug = '';
	let sourceIdentifier = '';
	let targetIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Status Mention Project' });
			const target = await seedTask(ws, project, { title: 'Target task title' });
			const source = await seedTask(ws, project, {
				title: 'Source task',
				description: `See also ${target.identifier} for related work.`,
			});
			// Set status directly: the closing automations (approval gates, child
			// checks) are irrelevant here and would make the terminal cases flaky.
			const { db } = getTestContext();
			await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
				targetStatus,
				target.id,
			]);
			projSlug = project.slug;
			targetIdentifier = target.identifier;
			sourceIdentifier = source.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projSlug, taskId: sourceIdentifier.toLowerCase() },
	});

	const link = (await findByTestId('task-mention-link', undefined, {
		timeout: 20_000,
	})) as HTMLAnchorElement;
	expect(link.textContent).toContain(targetIdentifier);
	return link;
}

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

test('a project-doc reference ending a sentence (trailing period) still renders a doc link', async () => {
	// Regression: a doc filename immediately followed by a sentence-ending period
	// (`Remove architecture-guidelines.md.`) used to fall out of the mention regex
	// because its trailing boundary rejected any following `.`, leaving the
	// filename as plain text instead of a clickable doc link.
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Doc Mention Project' });
			const task = await seedTask(ws, project, { title: 'Doc Mention Task' });
			const { apiBase } = getTestContext();
			await apiBase(`/api/projects/${project.slug}/docs/architecture-guidelines.md`, {
				method: 'PUT',
				headers: ws.headers,
				body: JSON.stringify({ content: '# Architecture Guidelines' }),
			});
			await seedComment(ws, task, 'Remove architecture-guidelines.md.');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// In a comment thread the doc mention opens in the preview panel, so it renders
	// as a preview button (not an href anchor) — the presence of the mention
	// element is what proves the filename linkified instead of staying plain text.
	const link = await findByTestId('doc-mention-link', undefined, { timeout: 20_000 });
	expect(link.textContent).toContain('architecture-guidelines.md');
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
	// …and is muted rather than sharing the active chip's colour. Without this the
	// only difference between "notified" and "merely named" is the missing "@", so
	// a reader scanning a thread cannot tell a routed handoff from a stranded one.
	expect(passiveLink.className).toContain('text-neutral-soft-fg');
	expect(passiveLink.className).not.toContain('text-info-soft-fg');
});

test('an active @agent mention keeps the emphasised chip styling', async () => {
	const seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Active Mention Project' });
			const task = await seedTask(ws, project, { title: 'Active Mention Task' });
			const agentSlug = ws.agents.find((a) => a.slug === 'captain')?.slug ?? ws.agents[0].slug;
			await seedComment(ws, task, `@${agentSlug} - please take a look at this one.`);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = agentSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText(/take a look at this one/, undefined, { timeout: 20_000 });
	const activeLink = await waitFor(() => {
		const el = container.querySelector(
			'[data-testid="agent-mention-link"]:not([data-mention-passive])',
		) as HTMLAnchorElement | null;
		if (!el) throw new Error('active mention link not yet resolved');
		return el;
	});
	// The active chip keeps the leading "@" and the emphasised treatment — the
	// contrast with the passive case above is the whole affordance.
	expect(activeLink.textContent).toBe(`@${seeded.agentSlug}`);
	expect(activeLink.className).toContain('text-info-soft-fg');
	expect(activeLink.className).toContain('font-semibold');
});

test('a mention of a done task strikes through the link and carries its status', async () => {
	const link = await renderTaskMention('done');
	// The threaded status drives both the strikethrough and the tooltip pill.
	expect(link.getAttribute('data-mention-task-status')).toBe('done');
	expect(link.className).toContain('line-through');
});

test('a mention of a cancelled task strikes through the link', async () => {
	const link = await renderTaskMention('cancelled');
	expect(link.getAttribute('data-mention-task-status')).toBe('cancelled');
	expect(link.className).toContain('line-through');
});

test('a mention of an open (in-progress) task is not struck through', async () => {
	const link = await renderTaskMention('in_progress');
	expect(link.getAttribute('data-mention-task-status')).toBe('in_progress');
	expect(link.className).not.toContain('line-through');
});

// The status pill itself lives inside a Radix tooltip that only mounts its portal
// content on a real pointer hover — a path happy-dom can't drive — so the
// hover→pill assertion lives in test/browser/task-mention-status.spec.ts. The
// `data-mention-task-status` assertions above prove the exact value that feeds the
// pill reaches the DOM.

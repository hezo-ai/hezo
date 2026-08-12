import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

interface HandoffFixture {
	projectSlug: string;
	teamId: string;
	captain: { id: string; slug: string; title: string };
	architect: { id: string; slug: string; title: string };
	ceoTaskIdentifier: string;
}

async function setupHandoff(ws: SeededWorkspace): Promise<HandoffFixture> {
	const project = await seedProject(ws, { name: 'Handoff Project' });
	const captain = ws.agents.find((a) => a.slug === 'captain');
	const architect = ws.agents.find((a) => a.slug === 'architect');
	if (!captain || !architect) throw new Error('Captain and architect agents required');
	const ceoTask = await seedTask(ws, project, {
		title: 'Roadmap task',
		assignee_id: captain.id,
	});
	return {
		teamId: ws.team.id,
		projectSlug: project.slug,
		captain,
		architect,
		ceoTaskIdentifier: ceoTask.identifier.toLowerCase(),
	};
}

test('posting an @architect mention in a comment renders as a link to the architect page', async () => {
	let fix: HandoffFixture;
	const { findByPlaceholderText, findByRole, findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			fix = await setupHandoff(ws);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: fix!.projectSlug,
			taskId: fix!.ceoTaskIdentifier,
		},
	});

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	await user.click(composer);
	await user.type(composer, `@${fix!.architect.slug} please update the spec.`);
	const submit = await findByRole('button', { name: 'Comment' });
	await user.click(submit);

	await waitFor(
		async () => {
			const bodies = await findAllByTestId('text-comment-body');
			const match = bodies.find((b) => b.textContent?.includes('please update the spec'));
			expect(match).toBeDefined();
			const link = match!.querySelector('[data-testid="agent-mention-link"]');
			expect(link).not.toBeNull();
			// The chip prints what the agent is called, not the handle that was typed.
			expect(link!.textContent).toBe(`@${fix!.architect.title}`);
			expect(link!.getAttribute('href')).toBe(
				`/projects/${fix!.projectSlug}/agents/${fix!.architect.slug}`,
			);
		},
		{ timeout: 10_000 },
	);
});

test('comment with @mention inside a fenced code block does not render a mention link', async () => {
	let fix: HandoffFixture;
	const { findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			fix = await setupHandoff(ws);
			const body = `Here is the template we discussed:\n\`\`\`\n@${fix.architect.slug}\n\`\`\`\nThat's it.`;
			await apiBase(`/api/projects/${fix.projectSlug}/tasks/${fix.ceoTaskIdentifier}/comments`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ content_type: 'text', content: { text: body } }),
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: fix!.projectSlug,
			taskId: fix!.ceoTaskIdentifier,
		},
	});

	await waitFor(
		async () => {
			const bodies = await findAllByTestId('text-comment-body');
			const match = bodies.find((b) => b.textContent?.includes('template we discussed'));
			expect(match).toBeDefined();
			expect(match!.querySelectorAll(`a[href*="/agents/${fix!.architect.slug}"]`).length).toBe(0);
		},
		{ timeout: 10_000 },
	);
});

test('architect agent page is reachable via the mention link from a comment', async () => {
	let fix: HandoffFixture;
	const { findAllByTestId, findByTestId, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			fix = await setupHandoff(ws);
			await apiBase(`/api/projects/${fix.projectSlug}/tasks/${fix.ceoTaskIdentifier}/comments`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					content_type: 'text',
					content: { text: `@${fix.architect.slug} heads up` },
				}),
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: fix!.projectSlug,
			taskId: fix!.ceoTaskIdentifier,
		},
	});

	const links = await findAllByTestId('agent-mention-link');
	await user.click(links[0]);

	await findByTestId('agent-summary', undefined, { timeout: 10_000 });
	await findByRole('heading', { name: fix!.architect.title });
});

test('mentioning multiple agents in one comment renders all mentions', async () => {
	let fix: HandoffFixture;
	const { findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			fix = await setupHandoff(ws);
			await apiBase(`/api/projects/${fix.projectSlug}/tasks/${fix.ceoTaskIdentifier}/comments`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					content_type: 'text',
					content: {
						text: `cc @${fix.architect.slug} and @${fix.captain.slug} for visibility`,
					},
				}),
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: fix!.projectSlug,
			taskId: fix!.ceoTaskIdentifier,
		},
	});

	await waitFor(
		async () => {
			const bodies = await findAllByTestId('text-comment-body');
			const match = bodies.find((b) => b.textContent?.includes('for visibility'));
			expect(match).toBeDefined();
			expect(match!.querySelectorAll(`a[href*="/agents/${fix!.architect.slug}"]`).length).toBe(1);
			expect(match!.querySelectorAll(`a[href*="/agents/${fix!.captain.slug}"]`).length).toBe(1);
		},
		{ timeout: 10_000 },
	);
});

test('passive @@<slug> renders a clickable chip but stays marked passive', async () => {
	let fix: HandoffFixture;
	const { findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			fix = await setupHandoff(ws);
			await apiBase(`/api/projects/${fix.projectSlug}/tasks/${fix.ceoTaskIdentifier}/comments`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					content_type: 'text',
					content: {
						text: `Plan: BE-2 → @@${fix.architect.slug}, BE-3 → @@${fix.captain.slug}.`,
					},
				}),
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: fix!.projectSlug,
			taskId: fix!.ceoTaskIdentifier,
		},
	});

	await waitFor(
		async () => {
			const bodies = await findAllByTestId('text-comment-body');
			const match = bodies.find((b) => b.textContent?.includes('Plan:'));
			expect(match).toBeDefined();
			const archChips = match!.querySelectorAll(`a[href*="/agents/${fix!.architect.slug}"]`);
			expect(archChips).toHaveLength(1);
			expect(archChips[0].getAttribute('data-mention-passive')).toBe('true');
			expect(archChips[0].textContent).toBe(fix!.architect.title);
			const captChips = match!.querySelectorAll(`a[href*="/agents/${fix!.captain.slug}"]`);
			expect(captChips).toHaveLength(1);
			expect(captChips[0].getAttribute('data-mention-passive')).toBe('true');
			expect(captChips[0].textContent).toBe(fix!.captain.title);
		},
		{ timeout: 10_000 },
	);
});

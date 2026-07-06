// Coverage for components/markdown-prose.tsx branches the existing mention specs
// don't reach: keyboard activation of review highlights, the doc-mention tooltip
// body (size + relative-updated formatting), the instance-scoped @admin link
// (/home/inbox), and the asset-mention fallback when no signed URL is available
// (same-tab library link instead of a new-tab anchor).

import type { CeoMessage } from '@hezo/web/hooks/use-ceo-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MarkdownProse } from '../src/components/markdown-prose';
import { getTestContext, renderApp } from './helpers/render';
import { seedAsset, seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// ---------------------------------------------------------------------------
// Review highlights (standalone render — no router needed for <mark>).

test('a review highlight activates on click, Enter, and Space, and shows the active style', async () => {
	const onClick = vi.fn();
	const { getByTestId } = render(
		<QueryClientProvider client={new QueryClient()}>
			<MarkdownProse
				reviewAnnotations={[{ id: 'r1', quote: 'load-bearing clause', occurrence: 0 }]}
				onReviewHighlightClick={onClick}
				activeReviewId="r1"
			>
				The contract has a load-bearing clause we must keep.
			</MarkdownProse>
		</QueryClientProvider>,
	);

	const mark = getByTestId('review-highlight');
	expect(mark.textContent).toBe('load-bearing clause');
	// The active annotation renders with the ring treatment.
	expect(mark.className).toContain('ring-2');
	expect(mark.getAttribute('role')).toBe('button');

	fireEvent.click(mark);
	expect(onClick).toHaveBeenCalledWith('r1');

	fireEvent.keyDown(mark, { key: 'Enter' });
	expect(onClick).toHaveBeenCalledTimes(2);

	fireEvent.keyDown(mark, { key: ' ' });
	expect(onClick).toHaveBeenCalledTimes(3);

	// Other keys don't activate.
	fireEvent.keyDown(mark, { key: 'a' });
	expect(onClick).toHaveBeenCalledTimes(3);
});

test('an inactive review highlight renders the idle style', () => {
	const { getByTestId } = render(
		<QueryClientProvider client={new QueryClient()}>
			<MarkdownProse
				reviewAnnotations={[{ id: 'r1', quote: 'quoted words', occurrence: 0 }]}
				onReviewHighlightClick={() => {}}
				activeReviewId={null}
			>
				Some quoted words here.
			</MarkdownProse>
		</QueryClientProvider>,
	);
	expect(getByTestId('review-highlight').className).not.toContain('ring-2');
});

// ---------------------------------------------------------------------------
// KB-doc mention tooltip: DocTooltipContent + formatSize + formatRelative.

async function seedSkill(name: string, slug: string, content: string): Promise<void> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/skills', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, slug, content, description: 'A KB doc.' }),
	});
	if (res.status !== 201) throw new Error(`seed skill failed: ${res.status}`);
}

test('hovering a KB-doc mention shows its size (B, KB, and MB forms) and relative updated time', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			// One doc per formatSize bucket (B / KB / MB) so all three branches render.
			await seedSkill('Tiny', 'tiny-notes.md', 'x'.repeat(10));
			await seedSkill('Medium', 'medium-notes.md', 'y'.repeat(2048));
			await seedSkill('Large', 'large-notes.md', 'z'.repeat(Math.round(1.5 * 1024 * 1024)));
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'KB Tooltip Project' });
			const task = await seedTask(ws, project, { title: 'KB Tooltip Task' });
			await seedComment(
				ws,
				task,
				'Read tiny-notes.md then medium-notes.md and finally large-notes.md before starting.',
			);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const links = await findAllByTestId('kb-mention-link', undefined, { timeout: 20_000 });
	expect(links).toHaveLength(3);
	const tiny = links.find((l) => l.textContent?.includes('tiny-notes.md'));
	const medium = links.find((l) => l.textContent?.includes('medium-notes.md'));
	const large = links.find((l) => l.textContent?.includes('large-notes.md'));

	// Tooltip content renders in a portal on hover: "<size> · updated <relative>".
	await user.hover(tiny as HTMLElement);
	await waitFor(() => expect(document.body.textContent).toMatch(/10 B · updated /));
	// Freshly seeded → the relative formatter lands in the seconds bucket.
	expect(document.body.textContent).toMatch(/10 B · updated (now|\d+ seconds? ago)/);
	await user.unhover(tiny as HTMLElement);

	await user.hover(medium as HTMLElement);
	await waitFor(() => expect(document.body.textContent).toMatch(/2\.0 KB · updated /));
	await user.unhover(medium as HTMLElement);

	await user.hover(large as HTMLElement);
	await waitFor(() => expect(document.body.textContent).toMatch(/1\.5 MB · updated /));
});

// ---------------------------------------------------------------------------
// Instance scope (CEO chat): @admin links to the global inbox.

test('@admin in a CEO reply (instance scope, no project) links to /home/inbox', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	// The harness backend has no CeoSessionManager, so the reply is seeded into
	// the conversation cache (same pattern as ceo-chat-mentions.test.tsx). The
	// passive @@captain mention guarantees the mention plugin runs.
	queryClient.setQueryData(queryKeys.ceoConversation(), {
		conversation_id: 'test-convo',
		messages: [
			{
				id: 'a1',
				role: 'assistant',
				channel: 'web',
				status: 'complete',
				content: 'Ask @admin to approve — context for @@captain.',
				created_at: new Date().toISOString(),
			} as CeoMessage,
		],
	});

	const link = await findByTestId('admin-mention-link');
	// Instance scope has no project, so the admin mention goes to the global inbox.
	expect(link.getAttribute('href')).toBe('/home/inbox');
	expect(link.textContent).toContain('@admin');
});

// ---------------------------------------------------------------------------
// Asset mention without a signed URL: same-tab library link fallback.

test('an asset mention with no signed URL falls back to a same-tab assets-library link', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Unsigned Asset' });
			await seedAsset(ws, project, { filename: 'login.png' });
			const task = await seedTask(ws, project, { title: 'Unsigned Asset Task' });
			await seedComment(ws, task, 'Match assets/login.png before you start.');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	// The live server always signs asset URLs; a missing/empty signature (e.g. a
	// locked vault) must degrade to the library link. Strip the signature from
	// the resolve response underneath the page.
	const passthrough = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
		const res = await passthrough(input as RequestInfo, init);
		if (url.includes('/docs/resolve')) {
			const body = (await res.json()) as {
				data?: { assets?: Array<{ signed_url?: string }> };
			};
			for (const a of body.data?.assets ?? []) a.signed_url = '';
			return new Response(JSON.stringify(body), {
				status: res.status,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return res;
	}) as typeof globalThis.fetch;

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const link = await findByTestId('asset-mention-link', undefined, { timeout: 20_000 });
	// Same-tab router link into the assets library, keyed to the file…
	expect(link.getAttribute('href')).toBe(`/projects/${seeded.projectSlug}/assets?file=login.png`);
	expect(link.getAttribute('target')).toBeNull();
	// …with no new-tab icon (that suffix marks dedicated-view links only).
	expect(queryByTestId('asset-mention-preview-link')).toBeNull();
});

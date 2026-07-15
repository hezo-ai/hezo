// Real Chromium (testing decision tree #1 + #4): a pending @admin notification
// must be marked read only once its comment actually scrolls into the real
// viewport. The below-the-fold comment has to stay unread until a real scroll
// brings it on screen — happy-dom has no layout and its stubbed
// IntersectionObserver reports every mounted row as visible, so this precision
// can only be proven in the browser. The mark-on-view wiring and cross-task
// scoping are covered cheaply by
// packages/web/test/task-comment-notification-read.test.tsx.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

const TOP = 'TOP-MENTION-MARKER';
const BOTTOM = 'BOTTOM-MENTION-MARKER';

/** Mint an active (admin-minted) API key; returns its one-time raw token. */
async function mintApiKey(page: Page, token: string): Promise<string> {
	const res = await page.request.post('/api/api-keys', {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { name: uniqueName('inbox-seed') },
	});
	if (!res.ok()) throw new Error(`mintApiKey failed — ${res.status()} ${await res.text()}`);
	return ((await res.json()) as { data: { key: string } }).data.key;
}

/**
 * Post a comment through the MCP surface as the API key. The key authors as its
 * own identity (not the session user), so an `@admin` mention is NOT excluded by
 * author and reaches the logged-in superuser's inbox — the only HTTP path that
 * seeds a self-mention for the session user.
 */
async function mcpCreateComment(
	page: Page,
	apiKey: string,
	projectSlug: string,
	taskId: string,
	content: string,
): Promise<void> {
	const res = await page.request.post('/mcp', {
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		data: {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'create_comment',
				arguments: { project: projectSlug, task_id: taskId, content },
			},
		},
	});
	if (!res.ok()) throw new Error(`mcpCreateComment failed — ${res.status()} ${await res.text()}`);
	const body = (await res.json()) as {
		error?: unknown;
		result?: { isError?: boolean; content?: Array<{ text?: string }> };
	};
	if (body.error) throw new Error(`create_comment JSON-RPC error: ${JSON.stringify(body.error)}`);
	if (body.result?.isError) {
		throw new Error(`create_comment tool error: ${JSON.stringify(body.result.content)}`);
	}
}

/** read_at for the caller's admin-mention whose comment snippet carries `marker`. */
async function mentionReadAt(
	page: Page,
	projectSlug: string,
	token: string,
	marker: string,
): Promise<string | null | 'missing'> {
	const res = await page.request.get(`/api/projects/${projectSlug}/inbox/mentions`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const mentions = (
		(await res.json()) as { data: Array<{ snippet: string; read_at: string | null }> }
	).data;
	const found = mentions.find((m) => m.snippet.includes(marker));
	return found ? found.read_at : 'missing';
}

const scrollMainToBottom = (page: Page) =>
	page
		.locator('main')
		.first()
		.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));

test.describe('Inbox notification read-on-view', () => {
	test('a comment marks its notification read only once it scrolls into view', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		test.setTimeout(90_000);
		// Tall viewport so the top mention is unambiguously above the fold and the
		// bottom one (30 comments later) unambiguously below it.
		await page.setViewportSize({ width: 1280, height: 900 });
		const { token } = sharedWorkspace;

		const projRes = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Inbox ReadOnView'),
			description: 'Read-on-view spec.',
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
		const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;
		const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers,
			data: { project_id: project.id, title: 'Read-on-view task', assignee_id: assigneeId },
		});
		const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

		const apiKey = await mintApiKey(page, token);

		// Top @admin comment — near the top, visible on load.
		await mcpCreateComment(page, apiKey, project.slug, task.id, `@admin ${TOP} please confirm.`);
		// Filler so the second mention sits well below the fold.
		const BATCH = 10;
		const COUNT = 30;
		for (let start = 0; start < COUNT; start += BATCH) {
			const batch = Array.from({ length: Math.min(BATCH, COUNT - start) }, (_, i) => start + i);
			await Promise.all(
				batch.map((i) =>
					page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
						headers,
						data: {
							content_type: 'text',
							content: { text: `filler ${i}. ${'lorem ipsum '.repeat(8)}` },
						},
					}),
				),
			);
		}
		// Bottom @admin comment — below the fold.
		await mcpCreateComment(page, apiKey, project.slug, task.id, `@admin ${BOTTOM} please confirm.`);

		// Both notifications start unread.
		expect(await mentionReadAt(page, project.slug, token, TOP)).toBeNull();
		expect(await mentionReadAt(page, project.slug, token, BOTTOM)).toBeNull();

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);
		// The thread loads at the top by default; pin it there so the assertion isn't
		// racing any late scroll.
		await page
			.locator('main')
			.first()
			.evaluate((el) => el.scrollTo({ top: 0 }));

		// The visible top comment's notification is marked read on view.
		await expect
			.poll(() => mentionReadAt(page, project.slug, token, TOP), { timeout: 20_000 })
			.not.toBeNull();

		// The below-the-fold comment's notification is still unread — never seen.
		expect(await mentionReadAt(page, project.slug, token, BOTTOM)).toBeNull();

		// Scroll it into view → it now gets marked read. Re-scroll each poll so
		// Virtuoso's post-mount height growth can't leave the row short of the
		// viewport.
		await expect
			.poll(
				async () => {
					await scrollMainToBottom(page);
					return mentionReadAt(page, project.slug, token, BOTTOM);
				},
				{ timeout: 20_000, intervals: [500, 1000, 1000, 2000] },
			)
			.not.toBeNull();
	});
});

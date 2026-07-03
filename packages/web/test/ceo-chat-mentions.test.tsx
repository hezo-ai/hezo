import type { CeoMessage } from '@hezo/web/hooks/use-ceo-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedAsset, seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The CEO chat renders replies in instance scope: entity references resolve
// through the real in-process backend (POST /api/mentions/resolve) and unique
// ones become client-side <Link>s. The harness has no CeoSessionManager, so
// replies are seeded straight into the conversation query cache the widget
// reads (same pattern as ceo-chat.test.tsx).

const now = () => new Date().toISOString();

function seedCeoReply(content: string) {
	queryClient.setQueryData(queryKeys.ceoConversation(), {
		conversation_id: 'test-convo',
		messages: [
			{
				id: 'a1',
				role: 'assistant',
				channel: 'web',
				status: 'complete',
				content,
				created_at: now(),
			} as CeoMessage,
		],
	});
}

interface SeededRefs {
	projectSlug: string;
	taskIdentifier: string;
	commentId: string;
	assetFilename: string;
}

async function seedEntities(): Promise<SeededRefs> {
	const ws = await seedWorkspace();
	const project = await seedProject(ws, { name: 'Demo' });
	const task = await seedTask(ws, project, { title: 'Demo Task' });
	const comment = await seedComment(ws, task, 'first comment');
	const { apiBase } = getTestContext();
	await apiBase(`/api/projects/${project.slug}/docs/prd.md`, {
		method: 'PUT',
		headers: ws.headers,
		body: JSON.stringify({ content: '# PRD' }),
	});
	const asset = await seedAsset(ws, project, { filename: 'login.png' });
	// commentId carries the comment's public_id — the slug used in `#comment-…`
	// deep-links and `<TASK-ID>#comment-…` mention references.
	return {
		projectSlug: project.slug,
		taskIdentifier: task.identifier,
		commentId: comment.public_id,
		assetFilename: asset.original_filename,
	};
}

test('CEO replies render unique refs as links; unknown and backticked refs stay plain', async () => {
	let refs!: SeededRefs;
	const { findByTestId, getByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			refs = await seedEntities();
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	const ident = refs.taskIdentifier;
	seedCeoReply(
		[
			`Progress lives in ${ident} — see ${ident}#comment-${refs.commentId} and prd.md for context.`,
			`The spec for ZZ-99 is pending. Mention syntax: \`${ident}\`.`,
		].join('\n\n'),
	);

	const taskLink = await findByTestId('task-mention-link');
	expect(taskLink.getAttribute('href')).toBe(
		`/projects/${refs.projectSlug}/tasks/${ident.toLowerCase()}`,
	);

	const commentLink = getByTestId('comment-mention-link');
	expect(commentLink.getAttribute('href')).toBe(
		`/projects/${refs.projectSlug}/tasks/${ident.toLowerCase()}#comment-${refs.commentId}`,
	);

	// The doc name now opens the standalone preview in a new tab (same as the suffix).
	const docLink = getByTestId('doc-mention-link');
	expect(docLink.getAttribute('href')).toBe(`/preview/${refs.projectSlug}/prd.md`);
	expect(docLink.getAttribute('target')).toBe('_blank');

	// Unknown identifiers stay plain text — no link wraps ZZ-99.
	const body = getByTestId('ceo-chat-markdown');
	const linkTexts = Array.from(body.querySelectorAll('a')).map((a) => a.textContent);
	expect(linkTexts).not.toContain('ZZ-99');
	expect(body.textContent).toContain('ZZ-99');

	// Backticked *task* references stay inert code — only backticked doc/asset
	// references linkify in chat (covered by the next test).
	const codeTexts = Array.from(body.querySelectorAll('code')).map((el) => el.textContent);
	expect(codeTexts).toContain(ident);
});

test('CEO replies linkify backticked doc and asset references, opening them in a new tab', async () => {
	let refs!: SeededRefs;
	const { findByTestId, getByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			refs = await seedEntities();
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	// The exact shape that misfired in production: an LLM-authored reply that wraps
	// the doc/asset filenames in backticks. They must still resolve to new-tab links
	// instead of rendering as inert code the operator can't click.
	seedCeoReply(`The report is at \`prd.md\` and the mockup is \`assets/${refs.assetFilename}\`.`);

	const docLink = await findByTestId('doc-mention-link');
	expect(docLink.textContent).toBe('prd.md');
	expect(docLink.getAttribute('href')).toBe(`/preview/${refs.projectSlug}/prd.md`);
	expect(docLink.getAttribute('target')).toBe('_blank');

	const assetLink = getByTestId('asset-mention-link');
	expect(assetLink.textContent).toContain(`assets/${refs.assetFilename}`);
	expect(assetLink.getAttribute('href')).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
	expect(assetLink.getAttribute('target')).toBe('_blank');

	// The backticked refs are no longer rendered as inert <code>.
	const body = getByTestId('ceo-chat-markdown');
	const codeTexts = Array.from(body.querySelectorAll('code')).map((el) => el.textContent);
	expect(codeTexts).not.toContain('prd.md');
	expect(codeTexts).not.toContain(`assets/${refs.assetFilename}`);
});

test('clicking a chat comment link navigates client-side with the chat still open', async () => {
	let refs!: SeededRefs;
	const { findByTestId, getByTestId, router, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			refs = await seedEntities();
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	seedCeoReply(`Answered in ${refs.taskIdentifier}#comment-${refs.commentId}.`);

	await user.click(await findByTestId('comment-mention-link'));

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(
			`/projects/${refs.projectSlug}/tasks/${refs.taskIdentifier.toLowerCase()}`,
		),
	);
	expect(router.state.location.hash).toBe(`comment-${refs.commentId}`);

	// The widget lives in the root layout, outside the route outlet — the panel
	// (and the rendered reply) survive the navigation.
	expect(getByTestId('ceo-chat-panel')).toBeTruthy();
	expect(getByTestId('ceo-chat-markdown')).toBeTruthy();
});

test('agent mentions link to the agent home project; HQ singletons resolve to hq', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	seedCeoReply('Ask @@ceo to review.');

	const agentLink = await findByTestId('agent-mention-link');
	expect(agentLink.getAttribute('href')).toBe('/projects/hq/agents/ceo');
	expect(agentLink.textContent).toBe('ceo');
});

test('an unresolved passive @@mention sheds its @@ prefix and renders as the bare slug', async () => {
	// Instance-wide resolution drops references that aren't unique across every team
	// (an agent slug like `captain` collides — every Startup team has one), so the
	// passive mention never links. It must still degrade to the bare slug, not leak
	// the internal `@@` authoring syntax to the reader.
	const { findByTestId, getByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	seedCeoReply('HM-70 is with @@nonexistentrole — two focused amendments.');

	const body = await findByTestId('ceo-chat-markdown');
	await waitFor(() => {
		if (!getByTestId('ceo-chat-markdown').textContent?.includes('nonexistentrole')) {
			throw new Error('reply not rendered yet');
		}
	});
	// The `@@` prefix is stripped; the bare slug remains as plain text, not a link.
	expect(body.textContent).toContain('is with nonexistentrole');
	expect(body.textContent).not.toContain('@@');
	expect(body.querySelector('[data-testid="agent-mention-link"]')).toBeNull();
});

// Branch-coverage tests for the system-comment renderer. These exercise the
// many event/change variants (status_change, run_failed, repo_designated,
// task_link, generic fallback) and their optional-field / null-fallback paths
// directly, with a minimal standalone TanStack router so <Link> resolves —
// no full app boot needed (the logic under test is pure rendering).

import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type React from 'react';
import { expect, test } from 'vitest';
import type { CommentDataOf } from '../src/components/comment-renderers/comment-data';
import { SystemComment } from '../src/components/comment-renderers/system-comment';
import { withI18n } from './helpers/i18n';

function renderNode(node: React.ReactNode) {
	const rootRoute = createRootRoute({ component: () => node });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	return render(
		// The event sentences resolve through the message catalog, and anything
		// drawing a tooltip needs the provider main.tsx mounts, so these get both
		// just as the app shell supplies them above the router.
		withI18n(
			// biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary.
			<RouterProvider router={router as any} />,
		),
	);
}

type Content = CommentDataOf<'system'>['content'];

function comment(
	content: Content,
	overrides: Partial<CommentDataOf<'system'>> = {},
): CommentDataOf<'system'> {
	return {
		id: 'c1',
		public_id: 'p1',
		content_type: 'system',
		content,
		author_type: 'admin',
		author_name: 'Alice',
		created_at: '2026-01-01T00:00:00Z',
		...overrides,
	} as CommentDataOf<'system'>;
}

function renderSystem(c: CommentDataOf<'system'>, projectId?: string) {
	return renderNode(<SystemComment comment={c} projectId={projectId} />);
}

// ─── status_change ────────────────────────────────────────────────────────

test('status_change renders from/to with formatted labels and actor name', async () => {
	const { findByText } = renderSystem(
		comment({ kind: 'status_change', from: 'backlog', to: 'in_progress' }, { author_name: 'Bob' }),
	);
	const el = await findByText(/changed status/);
	expect(el.textContent).toContain('Bob');
	expect(el.textContent).toContain('Backlog');
	expect(el.textContent).toContain('In Progress');
});

test('status_change falls back to "Admin" when author_name is absent', async () => {
	const { findByText } = renderSystem(
		comment({ kind: 'status_change', from: 'in_progress', to: 'done' }, { author_name: undefined }),
	);
	expect((await findByText(/changed status/)).textContent).toContain('Admin');
});

test('status_change with non-string from/to renders empty (formatTaskStatus of "")', async () => {
	const { findByText } = renderSystem(
		comment({
			kind: 'status_change',
			from: undefined,
			to: undefined,
		}),
	);
	// from/to coerce to '' → formatTaskStatus('') === '' (unknown key fallback).
	const el = await findByText(/changed status from/);
	expect(el.textContent).toContain('changed status from  to');
});

test('status_change auto_unblock cascade with trigger task renders a link', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'status_change',
			from: 'blocked',
			to: 'in_progress',
			cascade: 'auto_unblock',
			triggered_by_identifier: 'PROJ-42',
			triggered_by_project_slug: 'other-proj',
		}),
		'this-proj',
	);
	const link = (await findByTestId('cascade-trigger-task')) as HTMLAnchorElement;
	expect(link.textContent).toBe('PROJ-42');
	expect(link.getAttribute('href')).toContain('/projects/other-proj/tasks/proj-42');
});

test('status_change auto_unblock cascade without a trigger identifier shows "a blocker"', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'status_change',
			cascade: 'auto_unblock',
			// No triggered_by_identifier / slug → span fallback "a blocker".
		}),
		'this-proj',
	);
	const wrapper = await findByTestId('status-change-cascade');
	expect(wrapper.textContent).toContain('Auto-unblocked');
	expect(wrapper.textContent).toContain('a blocker');
});

test('status_change auto_unblock with identifier but no slug shows identifier as plain text', async () => {
	const { findByTestId, queryByTestId } = renderSystem(
		comment({
			kind: 'status_change',
			cascade: 'auto_unblock',
			triggered_by_identifier: 'PROJ-9',
			// missing slug → span (not link)
		}),
		'this-proj',
	);
	const wrapper = await findByTestId('status-change-cascade');
	expect(wrapper.textContent).toContain('PROJ-9');
	expect(queryByTestId('cascade-trigger-task')).toBeNull();
});

test('status_change auto_unblock WITHOUT projectId falls through to the plain status body', async () => {
	// projectId undefined → the cascade branch is skipped, normal body renders.
	const { findByText, queryByTestId } = renderSystem(
		comment({
			kind: 'status_change',
			from: 'blocked',
			to: 'in_progress',
			cascade: 'auto_unblock',
			triggered_by_identifier: 'PROJ-1',
			triggered_by_project_slug: 'p',
		}),
		undefined,
	);
	expect((await findByText(/changed status/)).textContent).toBeTruthy();
	expect(queryByTestId('status-change-cascade')).toBeNull();
});

// ─── run_abandoned ────────────────────────────────────────────────────────

test('run_abandoned: says the run could not be started, not that it failed', async () => {
	// Its own sentence rather than a status variable on the failed one: this run
	// never began, so "failed" would be untrue, and several of the twelve
	// languages inflect the two differently.
	const { findByTestId, queryByTestId } = renderSystem(
		comment({ kind: 'run_abandoned', agent_slug: 'risk-verifier', run_id: 'r1' }),
		'proj',
	);
	const wrapper = await findByTestId('run-abandoned-comment');
	expect(wrapper.textContent).toContain('could not be started');
	expect(wrapper.textContent).toContain('not be retried automatically');
	// And it is not the failed renderer wearing different copy.
	expect(queryByTestId('run-failed-comment')).toBeNull();

	const link = (await findByTestId('run-abandoned-agent')) as HTMLAnchorElement;
	expect(link.textContent).toBe('@risk-verifier');
	expect(link.getAttribute('href')).toContain('/projects/proj/agents/risk-verifier');
});

test('run_abandoned: no agent_slug → fallback span, no link', async () => {
	const { findByTestId, queryByTestId } = renderSystem(
		comment({ kind: 'run_abandoned', run_id: 'r1' }),
		'proj',
	);
	const wrapper = await findByTestId('run-abandoned-comment');
	expect(wrapper.textContent).toContain('agent');
	expect(queryByTestId('run-abandoned-agent')).toBeNull();
});

test('run_abandoned: agent_slug present but no projectId → span, no link', async () => {
	const { findByTestId, queryByTestId } = renderSystem(
		comment({ kind: 'run_abandoned', agent_slug: 'captain', run_id: 'r1' }),
	);
	await findByTestId('run-abandoned-comment');
	expect(queryByTestId('run-abandoned-agent')).toBeNull();
});

// ─── run_failed ───────────────────────────────────────────────────────────

test('run_failed: timed_out status, agent link, and error suffix', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'run_failed',
			agent_slug: 'captain',
			status: 'timed_out',
			error: 'boom',
		}),
		'proj',
	);
	const wrapper = await findByTestId('run-failed-comment');
	expect(wrapper.textContent).toContain('timed out');
	expect(wrapper.textContent).toContain('boom');
	const link = (await findByTestId('run-failed-agent')) as HTMLAnchorElement;
	expect(link.textContent).toBe('@captain');
	expect(link.getAttribute('href')).toContain('/projects/proj/agents/captain');
});

test('run_failed: default status label is "failed" and empty error renders no suffix', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'run_failed',
			agent_slug: 'qa',
			// no status → 'failed'; error '' → null → no suffix
			error: '',
		}),
		'proj',
	);
	const wrapper = await findByTestId('run-failed-comment');
	// "Run for @qa failed." with no ": <error>" segment after the agent.
	expect(wrapper.textContent).toContain('@qa failed.');
});

test('run_failed: no agent_slug → "agent" span (no link)', async () => {
	const { findByTestId, queryByTestId } = renderSystem(
		comment({ kind: 'run_failed', status: 'failed' }),
		'proj',
	);
	const wrapper = await findByTestId('run-failed-comment');
	expect(wrapper.textContent).toContain('agent');
	expect(queryByTestId('run-failed-agent')).toBeNull();
});

test('run_failed: agent_slug present but no projectId → span (no link)', async () => {
	const { findByTestId, queryByTestId } = renderSystem(
		comment({ kind: 'run_failed', agent_slug: 'captain' }),
		undefined,
	);
	expect(await findByTestId('run-failed-comment')).toBeTruthy();
	expect(queryByTestId('run-failed-agent')).toBeNull();
});

// The status x error-present matrix picks between four separate catalog keys
// (the status word inflects with the sentence in several languages, so it
// cannot be a {status} var). The two tests above cover timed_out-with-error and
// failed-without; these cover the remaining two corners.

test('run_failed: failed status with an error renders the error variant', async () => {
	const { findByTestId } = renderSystem(
		comment({ kind: 'run_failed', agent_slug: 'qa', status: 'failed', error: 'exit 1' }),
		'proj',
	);
	const wrapper = await findByTestId('run-failed-comment');
	expect(wrapper.textContent).toContain('failed');
	expect(wrapper.textContent).toContain('exit 1');
	expect(wrapper.textContent).not.toContain('timed out');
});

test('run_failed: timed_out with no error renders the plain timed-out variant', async () => {
	const { findByTestId } = renderSystem(
		comment({ kind: 'run_failed', agent_slug: 'qa', status: 'timed_out' }),
		'proj',
	);
	const wrapper = await findByTestId('run-failed-comment');
	expect(wrapper.textContent).toContain('timed out.');
	// No error present, so no ": <error>" clause is appended.
	expect(wrapper.textContent).not.toContain(':');
});

// ─── repo_designated ──────────────────────────────────────────────────────

test('repo_designated with a github identifier renders an external link', async () => {
	const { findByTestId } = renderSystem(
		comment({ kind: 'repo_designated', repo_identifier: 'acme/widgets', host_type: 'github' }),
	);
	const link = (await findByTestId('repo-designated-link')) as HTMLAnchorElement;
	expect(link.textContent).toBe('acme/widgets');
	expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets');
	expect(link.getAttribute('target')).toBe('_blank');
});

test('repo_designated with a non-github host renders plain text (repoWebUrl → null)', async () => {
	const { findByTestId, queryByTestId } = renderSystem(
		comment({ kind: 'repo_designated', repo_identifier: 'acme/widgets', host_type: 'gitlab' }),
	);
	const wrapper = await findByTestId('repo-designated-comment');
	expect(wrapper.textContent).toContain('acme/widgets');
	expect(queryByTestId('repo-designated-link')).toBeNull();
});

test('repo_designated with no identifier renders plain text fallback', async () => {
	const { findByTestId, queryByTestId } = renderSystem(comment({ kind: 'repo_designated' }));
	expect(await findByTestId('repo-designated-comment')).toBeTruthy();
	expect(queryByTestId('repo-designated-link')).toBeNull();
});

// ─── task_link ────────────────────────────────────────────────────────────

test('task_link: source link + agent actor link', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'task_link',
			source_identifier: 'SRC-1',
			source_project_slug: 'src-proj',
			actor_name: 'Captain',
			actor_kind: 'agent',
			actor_slug: 'captain',
		}),
		'cur-proj',
	);
	const source = (await findByTestId('task-link-source')) as HTMLAnchorElement;
	expect(source.textContent).toBe('SRC-1');
	expect(source.getAttribute('href')).toContain('/projects/src-proj/tasks/src-1');
	const actor = (await findByTestId('task-link-actor')) as HTMLAnchorElement;
	expect(actor.textContent).toBe('Captain');
	expect(actor.getAttribute('href')).toContain('/projects/cur-proj/agents/captain');
});

test('task_link: missing source identifier → span; non-agent actor → span', async () => {
	const { findByText, queryByTestId } = renderSystem(
		comment(
			{
				kind: 'task_link',
				// no source_identifier/slug → source span
				actor_kind: 'user',
				actor_name: 'Human',
			},
			{ author_name: 'AuthorFallback' },
		),
		'cur-proj',
	);
	expect((await findByText(/Linked from/)).textContent).toContain('Human');
	expect(queryByTestId('task-link-source')).toBeNull();
	expect(queryByTestId('task-link-actor')).toBeNull();
});

test('task_link: actor_kind agent but no actor_slug → actor span (no link)', async () => {
	const { findByText, queryByTestId } = renderSystem(
		comment({
			kind: 'task_link',
			source_identifier: 'SRC-2',
			source_project_slug: 'sp',
			actor_kind: 'agent',
			actor_slug: null,
			actor_name: 'NamelessAgent',
		}),
		'cur-proj',
	);
	expect((await findByText(/Linked from/)).textContent).toContain('NamelessAgent');
	expect(queryByTestId('task-link-actor')).toBeNull();
});

test('task_link: falls back to comment.author_name then "Admin" when actor_name absent', async () => {
	const { findByText } = renderSystem(
		comment(
			{ kind: 'task_link', source_identifier: 'SRC-3', source_project_slug: 'sp' },
			{ author_name: 'CommentAuthor' },
		),
		'cur-proj',
	);
	expect((await findByText(/Linked from/)).textContent).toContain('CommentAuthor');
});

test('task_link from a comment deep-links to that comment as well as the task', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'task_link',
			source_identifier: 'SRC-5',
			source_project_slug: 'src-proj',
			source_kind: 'comment',
			source_comment_public_id: '20260730120000',
			actor_name: 'Captain',
			actor_kind: 'agent',
			actor_slug: 'captain',
		}),
		'cur-proj',
	);
	const link = (await findByTestId('task-link-source-comment')) as HTMLAnchorElement;
	expect(link.textContent).toBe('a comment');
	expect(link.getAttribute('href')).toContain('/projects/src-proj/tasks/src-5');
	expect(link.getAttribute('href')).toContain('#comment-20260730120000');
	// The task itself stays reachable - the clause is added, nothing is replaced.
	const source = (await findByTestId('task-link-source')) as HTMLAnchorElement;
	expect(source.getAttribute('href')).toContain('/projects/src-proj/tasks/src-5');
});

test('task_link from a description renders no comment link', async () => {
	const { findByText, queryByTestId } = renderSystem(
		comment({
			kind: 'task_link',
			source_identifier: 'SRC-6',
			source_project_slug: 'src-proj',
			source_kind: 'description',
			source_comment_public_id: null,
			actor_name: 'Captain',
		}),
		'cur-proj',
	);
	expect((await findByText(/Linked from/)).textContent).toContain('SRC-6');
	expect(queryByTestId('task-link-source-comment')).toBeNull();
});

test('task_link recorded before the origin was tracked renders as it always did', async () => {
	// Rows written by an older build carry neither new field. They must keep the
	// original one-clause sentence rather than degrading to a broken link.
	const { findByText, queryByTestId } = renderSystem(
		comment({
			kind: 'task_link',
			source_identifier: 'SRC-7',
			source_project_slug: 'src-proj',
			actor_name: 'Captain',
		}),
		'cur-proj',
	);
	expect((await findByText(/Linked from/)).textContent).toContain('Linked from SRC-7 by Captain');
	expect(queryByTestId('task-link-source-comment')).toBeNull();
});

test('task_link without projectId does NOT use the task_link branch (renders generic fallback)', async () => {
	// The task_link branch requires projectId; without it, the renderer falls
	// through to the generic text fallback (JSON.stringify of the content).
	const { findByText } = renderSystem(
		comment({ kind: 'task_link', source_identifier: 'SRC-4', source_project_slug: 'sp' }),
		undefined,
	);
	const el = await findByText(/task_link/);
	expect(el.textContent).toContain('SRC-4');
});

// ─── description_change ───────────────────────────────────────────────────

test('description_change renders the sentence and hides the previews until expanded', async () => {
	const { findByText, findByTestId, queryByTestId } = renderSystem(
		comment({
			kind: 'description_change',
			text: 'Alice updated the description',
			from_preview: 'The old body.',
			to_preview: 'The new body.',
			from_truncated: false,
			to_truncated: false,
			from_length: 13,
			to_length: 13,
		}),
	);

	await findByText('Alice updated the description');
	expect(queryByTestId('description-change-before')).toBeNull();

	(await findByTestId('description-change-toggle')).click();

	expect((await findByTestId('description-change-before')).textContent).toBe('The old body.');
	expect((await findByTestId('description-change-after')).textContent).toBe('The new body.');
});

test('description_change marks a truncated preview with an ellipsis', async () => {
	const { findByTestId } = renderSystem(
		comment({
			kind: 'description_change',
			text: 'Alice added a description',
			from_preview: '',
			to_preview: 'x'.repeat(200),
			from_truncated: false,
			to_truncated: true,
			from_length: 0,
			to_length: 500,
		}),
	);

	(await findByTestId('description-change-toggle')).click();

	const after = await findByTestId('description-change-after');
	expect(after.textContent).toBe(`${'x'.repeat(200)}…`);
	// The "before" end is empty on an added description, so it renders nothing.
	expect(document.querySelector('[data-testid="description-change-before"]')).toBeNull();
});

test('description_change with no previews offers no toggle', async () => {
	const { findByText, queryByTestId } = renderSystem(
		comment({ kind: 'description_change', text: 'Alice cleared the description' }),
	);
	await findByText('Alice cleared the description');
	expect(queryByTestId('description-change-toggle')).toBeNull();
});

// ─── generic fallback ─────────────────────────────────────────────────────

test('generic system content renders its text field', async () => {
	const { findByText } = renderSystem(
		comment({ kind: 'title_change', text: 'Alice renamed the task' }),
	);
	expect((await findByText('Alice renamed the task')).textContent).toBe('Alice renamed the task');
});

test('generic system content without text JSON-stringifies the payload', async () => {
	const { findByText } = renderSystem(comment({ kind: 'run_terminated' }));
	expect((await findByText(/run_terminated/)).textContent).toContain('run_terminated');
});

test('non-object content stringifies via String(comment.content)', async () => {
	// content is a primitive string → first `typeof === object` check is false,
	// so `content` (typed) is null and we hit String(comment.content).
	const { findByText } = renderNode(
		<SystemComment
			comment={
				{
					id: 'c1',
					public_id: 'p1',
					content_type: 'system',
					content: 'raw-string-content',
					author_type: 'admin',
					author_name: 'Alice',
					created_at: '2026-01-01T00:00:00Z',
					// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed content for the fallback path.
				} as any
			}
		/>,
	);
	expect((await findByText('raw-string-content')).textContent).toBe('raw-string-content');
});

test('null content renders an empty fallback (no throw), with the actor badge', async () => {
	const { findByTestId } = renderNode(
		<SystemComment
			comment={
				{
					id: 'c1',
					public_id: 'p1',
					content_type: 'system',
					content: null,
					author_type: 'admin',
					author_name: 'Alice',
					created_at: '2026-01-01T00:00:00Z',
					// biome-ignore lint/suspicious/noExplicitAny: deliberately null content for the empty fallback.
				} as any
			}
		/>,
	);
	// content null AND comment.content null → text === '' (empty span); the
	// actor badge for an admin still renders, proving the fallback branch ran.
	expect(await findByTestId('actor-badge-human')).toBeTruthy();
});

test('parent_change links both ends of a move', async () => {
	const { findByTestId } = renderNode(
		<SystemComment
			comment={comment({
				kind: 'parent_change',
				from_identifier: 'OP-4',
				to_identifier: 'OP-9',
				from_project_slug: 'ops',
				to_project_slug: 'ops',
				text: 'Alice moved this task from OP-4 to OP-9',
			})}
			projectId="ops"
		/>,
	);
	const from = await findByTestId('parent-change-from');
	const to = await findByTestId('parent-change-to');
	expect(from.getAttribute('href')).toBe('/projects/ops/tasks/op-4');
	expect(to.getAttribute('href')).toBe('/projects/ops/tasks/op-9');
	expect((await findByTestId('parent-change-comment')).textContent).toContain('moved this task');
});

test('parent_change on a promotion has no destination link', async () => {
	const { findByTestId, queryByTestId } = renderNode(
		<SystemComment
			comment={comment({
				kind: 'parent_change',
				from_identifier: 'OP-4',
				to_identifier: null,
				from_project_slug: 'ops',
				to_project_slug: null,
			})}
			projectId="ops"
		/>,
	);
	expect(await findByTestId('parent-change-from')).toBeTruthy();
	expect(queryByTestId('parent-change-to')).toBeNull();
	expect((await findByTestId('parent-change-comment')).textContent).toContain(
		'promoted this task to top level',
	);
});

test('parent_change renders an end without a project slug as plain text', async () => {
	const { findByTestId, queryByTestId } = renderNode(
		<SystemComment
			comment={comment({
				kind: 'parent_change',
				from_identifier: null,
				to_identifier: 'OP-9',
				from_project_slug: null,
				to_project_slug: null,
			})}
			projectId="ops"
		/>,
	);
	expect(queryByTestId('parent-change-to')).toBeNull();
	expect((await findByTestId('parent-change-comment')).textContent).toContain(
		'nested this task under OP-9',
	);
});

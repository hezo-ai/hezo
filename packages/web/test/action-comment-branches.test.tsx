// Branch-coverage tests for the action-comment renderer: setup_repo states
// (resolved / unresolved / no-projectId), the graceful unrecognized-kind
// fallback, and delegation to the hire-proposal + goal-suggestion renderers.
// Minimal standalone router so the settings <Link>/<Button> resolve; a
// QueryClient so the goal-suggestion renderer's mutation hook mounts.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type React from 'react';
import { expect, test } from 'vitest';
import { ActionComment } from '../src/components/comment-renderers/action-comment';
import type { CommentDataOf } from '../src/components/comment-renderers/comment-data';

function renderNode(node: React.ReactNode) {
	const rootRoute = createRootRoute({ component: () => node });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			{/* biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary. */}
			<RouterProvider router={router as any} />
		</QueryClientProvider>,
	);
}

function actionComment(
	content: CommentDataOf<'action'>['content'],
	overrides: Partial<CommentDataOf<'action'>> = {},
): CommentDataOf<'action'> {
	return {
		id: 'a1',
		public_id: 'pa1',
		content_type: 'action',
		content,
		chosen_option: null,
		author_type: 'admin',
		author_name: 'Alice',
		created_at: '2026-01-01T00:00:00Z',
		...overrides,
	} as CommentDataOf<'action'>;
}

test('hire_proposal delegates to the HireProposalComment renderer', async () => {
	const { findByTestId } = renderNode(
		<ActionComment
			comment={actionComment(
				{ kind: 'hire_proposal', title: 'Backend Eng', role_description: 'builds APIs' },
				{ chosen_option: null },
			)}
			projectId="proj"
		/>,
	);
	// HireProposalComment (unresolved) renders the pending proposal card.
	const card = await findByTestId('hire-proposal-pending');
	expect(card.textContent).toContain('Backend Eng');
});

test('goal_suggestion delegates to the GoalSuggestionComment renderer', async () => {
	const { findByTestId } = renderNode(
		<ActionComment
			comment={actionComment({
				kind: 'goal_suggestion',
				approval_id: 'appr1',
				title: 'Reach 5k followers',
				measurement: '5000 followers',
				check_frequency: 'weekly',
			})}
			projectId="proj"
		/>,
	);
	// The pending suggestion card renders (not the unrecognized-kind fallback)...
	const card = await findByTestId('goal-suggestion-pending');
	expect(card.textContent).toContain('Reach 5k followers');
	// ...with the info tooltip explaining what a goal is next to the title.
	await findByTestId('goal-suggestion-info');
});

test('an unrecognized action kind renders the graceful "needs a newer version" fallback', async () => {
	const { findByTestId } = renderNode(
		<ActionComment comment={actionComment({ kind: 'something_new' })} projectId="proj" />,
	);
	const fallback = await findByTestId('action-unknown');
	// No scary "Unknown action: <kind>"; the message tells the user what to do,
	// and the raw kind is preserved only in the debug `title` attribute.
	expect(fallback.textContent).toMatch(/needs a newer version to display/i);
	expect(fallback.textContent).not.toContain('something_new');
	expect(fallback.getAttribute('title')).toContain('something_new');
});

test('a missing kind renders the graceful fallback with no debug title', async () => {
	const { findByTestId } = renderNode(
		<ActionComment comment={actionComment({})} projectId="proj" />,
	);
	const fallback = await findByTestId('action-unknown');
	expect(fallback.textContent).toMatch(/refresh the page/i);
	expect(fallback.getAttribute('title')).toBeNull();
});

test('setup_repo resolved shows the repo identifier from the result', async () => {
	const { findByTestId } = renderNode(
		<ActionComment
			comment={actionComment(
				{ kind: 'setup_repo' },
				{ chosen_option: { status: 'complete', result: { repo_identifier: 'acme/api' } } },
			)}
			projectId="proj"
		/>,
	);
	const done = await findByTestId('action-complete');
	expect(done.textContent).toContain('Repository set: acme/api');
});

test('setup_repo resolved without a result identifier shows "(unknown)"', async () => {
	const { findByTestId } = renderNode(
		<ActionComment
			comment={actionComment({ kind: 'setup_repo' }, { chosen_option: { status: 'complete' } })}
			projectId="proj"
		/>,
	);
	expect((await findByTestId('action-complete')).textContent).toContain('(unknown)');
});

test('setup_repo unresolved with projectId renders the setup-repo prompt and Git settings link', async () => {
	const { findByTestId } = renderNode(
		<ActionComment comment={actionComment({ kind: 'setup_repo' })} projectId="proj" />,
	);
	const prompt = await findByTestId('action-setup-repo');
	expect(prompt.textContent).toContain('no designated repository');
	const link = prompt.querySelector('a') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toContain('/projects/proj/git');
});

test('setup_repo unresolved without projectId renders the unavailable fallback', async () => {
	const { findByText, queryByTestId } = renderNode(
		<ActionComment comment={actionComment({ kind: 'setup_repo' })} projectId={undefined} />,
	);
	expect((await findByText(/Repo setup unavailable/)).textContent).toBeTruthy();
	expect(queryByTestId('action-setup-repo')).toBeNull();
});

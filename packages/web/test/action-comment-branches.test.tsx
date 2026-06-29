// Branch-coverage tests for the action-comment renderer: setup_repo states
// (resolved / unresolved / no-projectId), the unknown-action fallback, and
// delegation to the hire-proposal renderer. Minimal standalone router so the
// settings <Link>/<Button> resolve.

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
	// biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary.
	return render(<RouterProvider router={router as any} />);
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

test('unknown action kind renders the "Unknown action" fallback', async () => {
	const { findByText } = renderNode(
		<ActionComment comment={actionComment({ kind: 'something_new' })} projectId="proj" />,
	);
	expect((await findByText(/Unknown action/)).textContent).toContain('something_new');
});

test('missing kind renders the unknown-action fallback with empty kind', async () => {
	const { findByText } = renderNode(<ActionComment comment={actionComment({})} projectId="proj" />);
	expect((await findByText(/Unknown action/)).textContent).toBe('Unknown action: ');
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

test('setup_repo unresolved with projectId renders the setup-repo prompt and settings link', async () => {
	const { findByTestId } = renderNode(
		<ActionComment comment={actionComment({ kind: 'setup_repo' })} projectId="proj" />,
	);
	const prompt = await findByTestId('action-setup-repo');
	expect(prompt.textContent).toContain('no designated repository');
	const link = prompt.querySelector('a') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toContain('/projects/proj/settings');
});

test('setup_repo unresolved without projectId renders the unavailable fallback', async () => {
	const { findByText, queryByTestId } = renderNode(
		<ActionComment comment={actionComment({ kind: 'setup_repo' })} projectId={undefined} />,
	);
	expect((await findByText(/Repo setup unavailable/)).textContent).toBeTruthy();
	expect(queryByTestId('action-setup-repo')).toBeNull();
});

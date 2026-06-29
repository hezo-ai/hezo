// Branch-coverage for the text-comment renderer: the attachments ternary
// (present vs absent). Content normalization itself is covered by the
// `commentText` unit tests. A QueryClientProvider is supplied because
// MarkdownProse fans out mention-resolution queries on mount.

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
import type { CommentDataOf } from '../src/components/comment-renderers/comment-data';
import { TextComment } from '../src/components/comment-renderers/text-comment';

function renderNode(node: React.ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({ component: () => node });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	return render(
		<QueryClientProvider client={qc}>
			{/* biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary. */}
			<RouterProvider router={router as any} />
		</QueryClientProvider>,
	);
}

function textComment(overrides: Partial<CommentDataOf<'text'>> = {}): CommentDataOf<'text'> {
	return {
		id: 't1',
		public_id: 'pt1',
		content_type: 'text',
		content: 'hello world',
		created_at: '2026-01-01T00:00:00Z',
		...overrides,
	} as CommentDataOf<'text'>;
}

test('renders the markdown body and no attachment row when there are none', async () => {
	const { findByTestId, queryByTestId } = renderNode(<TextComment comment={textComment()} />);
	expect((await findByTestId('text-comment-body')).textContent).toContain('hello world');
	expect(queryByTestId('comment-attachments')).toBeNull();
});

test('renders the attachment thumbnails when attachments are present', async () => {
	const { findByTestId, findAllByTestId } = renderNode(
		<TextComment
			comment={textComment({
				content: 'see files',
				attachments: [
					{
						id: 'att1',
						original_filename: 'diagram.png',
						content_type: 'image/png',
						url: 'https://example.test/diagram.png',
						// biome-ignore lint/suspicious/noExplicitAny: minimal attachment shape for the renderer.
					} as any,
					{
						id: 'att2',
						original_filename: 'notes.pdf',
						content_type: 'application/pdf',
						url: 'https://example.test/notes.pdf',
						// biome-ignore lint/suspicious/noExplicitAny: minimal attachment shape for the renderer.
					} as any,
				],
			})}
		/>,
	);
	expect(await findByTestId('comment-attachments')).toBeTruthy();
	const thumbs = await findAllByTestId('comment-attachment-thumb');
	expect(thumbs.length).toBe(2);
});

test('empty attachments array still renders no attachment row', async () => {
	const { findByTestId, queryByTestId } = renderNode(
		<TextComment comment={textComment({ attachments: [] })} />,
	);
	expect(await findByTestId('text-comment-body')).toBeTruthy();
	// attachments.length > 0 is false → no row.
	expect(queryByTestId('comment-attachments')).toBeNull();
});

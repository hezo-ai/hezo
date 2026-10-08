// The summary-and-technical-details renderer: the summary always shows, the
// technical details sit behind a toggle that starts collapsed, and text without
// the marker renders as plain markdown with no toggle. A QueryClientProvider is
// supplied because MarkdownProse fans out mention-resolution queries on mount.

import { SUMMARY_DETAILS_HEADING } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render } from '@testing-library/react';
import type React from 'react';
import { expect, test } from 'vitest';
import type { CommentDataOf } from '../src/components/comment-renderers/comment-data';
import { TextComment } from '../src/components/comment-renderers/text-comment';
import { SummaryDetailsProse } from '../src/components/summary-details-prose';
import { withI18n } from './helpers/i18n';

function renderNode(node: React.ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({ component: () => node });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	return render(
		withI18n(
			<QueryClientProvider client={qc}>
				{/* biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary. */}
				<RouterProvider router={router as any} />
			</QueryClientProvider>,
		),
	);
}

const SPLIT = `Model re-run is done. **Expected return** is unchanged.\n\n${SUMMARY_DETAILS_HEADING}\n\n- source hash a1b2c3\n- replay count 42`;

test('shows the summary and keeps the technical details collapsed', async () => {
	const { findByTestId, getByTestId } = renderNode(
		<SummaryDetailsProse testId="body">{SPLIT}</SummaryDetailsProse>,
	);
	const body = await findByTestId('body');
	expect(body.textContent).toContain('Model re-run is done.');
	expect(body.textContent).not.toContain('replay count 42');
	expect(body.textContent).not.toContain('Technical details');
	const toggle = getByTestId('technical-details-toggle');
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	expect(toggle.textContent).toBe('Show technical details');
	expect(getByTestId('technical-details').hidden).toBe(true);
});

test('expands and collapses the technical details on click', async () => {
	const { findByTestId, getByTestId } = renderNode(
		<SummaryDetailsProse testId="body">{SPLIT}</SummaryDetailsProse>,
	);
	const toggle = await findByTestId('technical-details-toggle');
	fireEvent.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	expect(toggle.textContent).toBe('Hide technical details');
	const region = getByTestId('technical-details');
	expect(region.hidden).toBe(false);
	expect(toggle.getAttribute('aria-controls')).toBe(region.id);
	expect(region.textContent).toContain('replay count 42');
	fireEvent.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	expect(getByTestId('technical-details').textContent).toBe('');
});

test('renders text without the marker whole, with no toggle', async () => {
	const { findByTestId, queryByTestId } = renderNode(
		<SummaryDetailsProse testId="body">
			{'Reconnected.\n\n- daily check runs again'}
		</SummaryDetailsProse>,
	);
	expect((await findByTestId('body')).textContent).toContain('daily check runs again');
	expect(queryByTestId('technical-details-toggle')).toBeNull();
});

test('ignores a marker inside a fenced code block', async () => {
	const text = `Example of the format:\n\n\`\`\`md\n${SUMMARY_DETAILS_HEADING}\n\`\`\``;
	const { findByTestId, queryByTestId } = renderNode(
		<SummaryDetailsProse testId="body">{text}</SummaryDetailsProse>,
	);
	expect((await findByTestId('body')).textContent).toContain(SUMMARY_DETAILS_HEADING);
	expect(queryByTestId('technical-details-toggle')).toBeNull();
});

test('a text comment shows its summary with the technical details collapsed', async () => {
	const comment = {
		id: 't1',
		public_id: 'pt1',
		content_type: 'text',
		content: SPLIT,
		created_at: '2026-01-01T00:00:00Z',
	} as CommentDataOf<'text'>;
	const { findByTestId, getByTestId } = renderNode(<TextComment comment={comment} />);
	const body = await findByTestId('text-comment-body');
	expect(body.textContent).toContain('Model re-run is done.');
	expect(body.textContent).not.toContain('source hash');
	fireEvent.click(getByTestId('technical-details-toggle'));
	expect((await findByTestId('text-comment-body')).textContent).toContain('source hash a1b2c3');
});

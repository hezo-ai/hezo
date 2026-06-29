import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, test } from 'vitest';
import { MarkdownProse } from '../src/components/markdown-prose';

// Component tier (happy-dom). MarkdownProse's mention hooks call useQuery, so it
// renders under a QueryClientProvider. Without a backend the mention maps stay
// empty, so the remarkMentions plugin never activates and links fall through to
// the plain external-anchor branch — which is exactly the no-scope rendering we
// cover here, plus the testId/className wiring and basic markdown (code,
// headings, GFM). Mention-resolution link branches require the live backend and
// are covered by the mention-specific specs (e.g. ceo-chat-mentions).

function renderProse(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

test('renders markdown headings and inline code', () => {
	const { container, getByText } = renderProse(
		<MarkdownProse>{'# Title\n\nSome `inline code` here.'}</MarkdownProse>,
	);
	expect(container.querySelector('h1')?.textContent).toBe('Title');
	expect(getByText('inline code').tagName).toBe('CODE');
});

test('a bare link renders as a plain external anchor when no scope is set', () => {
	const { getByRole } = renderProse(
		<MarkdownProse>{'See [the docs](https://example.com/docs).'}</MarkdownProse>,
	);
	const link = getByRole('link', { name: 'the docs' }) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('https://example.com/docs');
	expect(link.getAttribute('target')).toBe('_blank');
	expect(link.getAttribute('rel')).toBe('noopener noreferrer');
	// No mention testIds since mention maps are empty.
	expect(link.getAttribute('data-testid')).toBeNull();
});

test('applies the testId and merges a custom className with the prose classes', () => {
	const { getByTestId } = renderProse(
		<MarkdownProse testId="summary-prose" className="extra-class">
			{'Body text.'}
		</MarkdownProse>,
	);
	const root = getByTestId('summary-prose');
	expect(root.className).toContain('extra-class');
	expect(root.className).toContain('prose');
	expect(root.textContent).toContain('Body text.');
});

test('renders GFM tables (remarkGfm always active)', () => {
	const { container } = renderProse(
		<MarkdownProse>{'| A | B |\n| - | - |\n| 1 | 2 |'}</MarkdownProse>,
	);
	expect(container.querySelector('table')).toBeTruthy();
	expect(container.querySelector('th')?.textContent).toBe('A');
});

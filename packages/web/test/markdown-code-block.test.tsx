// The copy affordance on rendered markdown code blocks. Fully standalone: with
// no projectId/instance every mention query in MarkdownProse is `enabled: false`
// and useOpenPreview() returns null outside a provider, so these need no backend
// and no router - just a QueryClient and the message catalog (the button's
// aria-label resolves through t()).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { codeBlockText } from '../src/components/markdown-code-block';
import { MarkdownProse } from '../src/components/markdown-prose';
import type { ReviewAnnotation } from '../src/lib/rehype-review-highlights';
import { withI18n } from './helpers/i18n';

function renderProse(markdown: string, reviewAnnotations?: ReviewAnnotation[]) {
	return render(
		withI18n(
			<QueryClientProvider client={new QueryClient()}>
				<MarkdownProse reviewAnnotations={reviewAnnotations} onReviewHighlightClick={() => {}}>
					{markdown}
				</MarkdownProse>
			</QueryClientProvider>,
		),
	);
}

/**
 * Swap in a recording clipboard for the duration of `fn`, restoring whatever
 * happy-dom had defined. Mirrors the stub in task-comments.test.tsx.
 */
async function withClipboard(fn: (writes: string[]) => Promise<void>) {
	const writes: string[] = [];
	const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (t: string) => {
				writes.push(t);
			},
		},
	});
	try {
		await fn(writes);
	} finally {
		if (originalDesc) Object.defineProperty(navigator, 'clipboard', originalDesc);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
}

test('a fenced block gets one copy button; inline code gets none', () => {
	const { container, queryAllByTestId } = renderProse(
		['Use `npm` inline.', '', '```sh', 'npm run build', '```', ''].join('\n'),
	);

	expect(queryAllByTestId('code-block-copy')).toHaveLength(1);

	// The inline chip is a bare <code> in the paragraph - not wrapped, no button.
	const inline = container.querySelector('p code');
	expect(inline?.textContent).toBe('npm');
	expect(inline?.closest('[data-testid="markdown-code-block"]')).toBeNull();

	// The one <pre> is the wrapped one.
	const pres = container.querySelectorAll('pre');
	expect(pres).toHaveLength(1);
	expect(pres[0].closest('[data-testid="markdown-code-block"]')).not.toBeNull();
});

test('clicking copies the exact fence contents, without the trailing newline', async () => {
	const user = userEvent.setup();
	const { getByTestId } = renderProse(
		['Before.', '', '```ts', 'const a = 1;', 'const b = 2;', '```', '', 'After.'].join('\n'),
	);

	await withClipboard(async (writes) => {
		await user.click(getByTestId('code-block-copy'));
		// mdast-util-to-hast appends one newline building <pre><code>; it is a
		// rendering artifact and must not land in the clipboard.
		expect(writes).toEqual(['const a = 1;\nconst b = 2;']);
	});
});

test('the button confirms the copy, then reverts', async () => {
	const user = userEvent.setup();
	const { getByTestId } = renderProse(['```', 'echo hi', '```'].join('\n'));

	const btn = getByTestId('code-block-copy');
	expect(btn.getAttribute('aria-label')).toBe('Copy');

	await withClipboard(async () => {
		await user.click(btn);
		await waitFor(() => expect(btn.getAttribute('aria-label')).toBe('Copied'));
	});
});

test('a review highlight inside a fence still copies the whole block', async () => {
	const user = userEvent.setup();
	const { getByTestId } = renderProse(['```sh', 'npm run build', '```'].join('\n'), [
		{ id: 'r1', quote: 'run build', occurrence: 0 },
	]);

	// The highlight really is inside the code block - i.e. the code's single text
	// node has been split, which is what defeats a naive textContent read.
	const mark = getByTestId('review-highlight');
	expect(mark.closest('pre')).not.toBeNull();

	await withClipboard(async (writes) => {
		await user.click(getByTestId('code-block-copy'));
		expect(writes).toEqual(['npm run build']);
	});
});

test('each code block tracks its own copied state', async () => {
	const user = userEvent.setup();
	const { getAllByTestId } = renderProse(
		['```', 'first', '```', '', '```', 'second', '```'].join('\n'),
	);

	const [first, second] = getAllByTestId('code-block-copy');
	await withClipboard(async (writes) => {
		await user.click(second);
		expect(writes).toEqual(['second']);
		await waitFor(() => expect(second.getAttribute('aria-label')).toBe('Copied'));
		expect(first.getAttribute('aria-label')).toBe('Copy');
	});
});

test('codeBlockText walks nested nodes and drops one trailing newline', () => {
	// The shape rehype-review-highlights produces: the code text split around a
	// <mark>, with the to-hast trailing newline on the end.
	const node = {
		type: 'element',
		tagName: 'pre',
		children: [
			{
				type: 'element',
				tagName: 'code',
				children: [
					{ type: 'text', value: 'npm ' },
					{
						type: 'element',
						tagName: 'mark',
						children: [{ type: 'text', value: 'run build' }],
					},
					{ type: 'text', value: '\n' },
				],
			},
		],
	};

	expect(codeBlockText(node)).toBe('npm run build');
	// Only one newline is an artifact; a deliberate blank final line survives.
	expect(codeBlockText({ type: 'text', value: 'a\n\n' })).toBe('a\n');
	expect(codeBlockText(undefined)).toBe('');
	expect(codeBlockText({ type: 'element', tagName: 'pre' })).toBe('');
});

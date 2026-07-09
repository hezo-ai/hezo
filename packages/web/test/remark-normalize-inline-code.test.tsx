import { render } from '@testing-library/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { expect, test } from 'vitest';
import {
	remarkNormalizeInlineCode,
	unwrapRedundantBackticks,
} from '../src/lib/remark-normalize-inline-code';

// remarkGfm must run first so the `` `x` `` double-wrap parses the same way it
// does in the real MarkdownProse pipeline.
function renderMd(text: string) {
	return render(<Markdown remarkPlugins={[remarkGfm, remarkNormalizeInlineCode]}>{text}</Markdown>);
}

function codeText(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('code')).map((c) => c.textContent ?? '');
}

test('a double-wrapped token renders as a clean chip, no inner backticks', () => {
	// The GFM parser turns `` `## FAQ` `` into one inlineCode node whose value is
	// the literal "`## FAQ`"; without normalization the chip shows the backticks.
	const { container } = renderMd('The 7 Q&A pairs are an inline `` `## FAQ` `` section.');
	expect(codeText(container)).toEqual(['## FAQ']);
	expect(container.textContent).not.toContain('`');
});

test('several double-wrapped tokens in one line all render clean', () => {
	const { container } = renderMd(
		'put FAQ in the `` `faq:` `` field of `` `data/README.md` `` at `` `localhost:3100` ``',
	);
	expect(codeText(container)).toEqual(['faq:', 'data/README.md', 'localhost:3100']);
	expect(container.textContent).not.toContain('`');
});

test('a normal single-backtick span is unchanged', () => {
	const { container } = renderMd('run `npm install` in `data/README.md`');
	expect(codeText(container)).toEqual(['npm install', 'data/README.md']);
});

test('a span that deliberately shows a backtick is left untouched', () => {
	// Inner content carries its own backtick, so the whole-span wrapper is not a
	// redundant double-wrap and must be preserved verbatim.
	const { container } = renderMd('the literal `` `a`b` `` token');
	expect(codeText(container)).toEqual(['`a`b`']);
});

test('a fenced code block keeps its backticks', () => {
	const { container } = renderMd(['```', '`still code`', '```'].join('\n'));
	// The fence is a `code` node, never an `inlineCode` node, so it is not visited.
	expect(container.querySelector('pre')?.textContent).toContain('`still code`');
});

test('unwrapRedundantBackticks unit cases', () => {
	expect(unwrapRedundantBackticks('`## FAQ`')).toBe('## FAQ');
	expect(unwrapRedundantBackticks('`faq:`')).toBe('faq:');
	expect(unwrapRedundantBackticks('`data/README.md`')).toBe('data/README.md');
	// Already clean — no interior backticks, no leading/trailing backtick.
	expect(unwrapRedundantBackticks('npm install')).toBe('npm install');
	// Interior backtick → not a redundant wrapper, preserved.
	expect(unwrapRedundantBackticks('`a`b`')).toBe('`a`b`');
	// Degenerate delimiters are left alone.
	expect(unwrapRedundantBackticks('`')).toBe('`');
	expect(unwrapRedundantBackticks('``')).toBe('``');
	// Whitespace padding inside the wrapper is trimmed away with it.
	expect(unwrapRedundantBackticks('` faq `')).toBe('faq');
});

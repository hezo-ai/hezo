import { render } from '@testing-library/react';
import Markdown from 'react-markdown';
import { expect, test } from 'vitest';
import { isCommentPublicId, remarkCommentRefs } from '../src/lib/remark-comment-refs';

// A comment's public_id is its creation-timestamp slug (YYYYMMDDHHMMSS, UTC),
// with an optional `-N` suffix for same-second collisions on a task.
const PUBLIC_ID = '20260618030521';
const TASK = { identifier: 'TO-7', title: 'Approve the spec', projectSlug: 'demo' };

function renderMd(text: string) {
	return render(<Markdown remarkPlugins={[[remarkCommentRefs, TASK]]}>{text}</Markdown>);
}

test('a bare public_id in prose links to the comment in the run task', () => {
	const { container } = renderMd(`The admin approved at ${PUBLIC_ID} just now.`);
	const link = container.querySelector('a[data-mention-comment-id]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('data-mention-comment-id')).toBe(PUBLIC_ID);
	expect(link?.getAttribute('data-mention-comment-task-identifier')).toBe('to-7');
	expect(link?.getAttribute('data-mention-comment-project-slug')).toBe('demo');
	expect(link?.getAttribute('href')).toBe(`/projects/demo/tasks/to-7#comment-${PUBLIC_ID}`);
	expect(link?.textContent).toBe(PUBLIC_ID);
});

test('a backticked public_id links — agents habitually wrap ids in inline code', () => {
	const { container } = renderMd(`Comment \`${PUBLIC_ID}\` says approved.`);
	const link = container.querySelector('a[data-mention-comment-id]');
	expect(link?.getAttribute('data-mention-comment-id')).toBe(PUBLIC_ID);
	expect(link?.getAttribute('href')).toBe(`/projects/demo/tasks/to-7#comment-${PUBLIC_ID}`);
});

test('a quoted, backticked public_id links (the `"<id>"` form)', () => {
	const { container } = renderMd(`posted at \`"${PUBLIC_ID}"\` per the log.`);
	expect(
		container.querySelector('a[data-mention-comment-id]')?.getAttribute('data-mention-comment-id'),
	).toBe(PUBLIC_ID);
});

test('a public_id with a -N disambiguation suffix still links', () => {
	const { container } = renderMd(`see ${PUBLIC_ID}-2 here`);
	expect(
		container.querySelector('a[data-mention-comment-id]')?.getAttribute('data-mention-comment-id'),
	).toBe(`${PUBLIC_ID}-2`);
});

test('a 14-digit number that is not a plausible timestamp is left untouched', () => {
	// month 99 / day 99 — fails the timestamp sanity check.
	const { container } = renderMd('order 20269999030521 shipped');
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
	expect(container.textContent).toContain('20269999030521');
});

test('real inline code is preserved as code, never linked', () => {
	const { container } = renderMd('run `npm install` and `git status 20260618030521`');
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
	const codes = Array.from(container.querySelectorAll('code')).map((c) => c.textContent);
	expect(codes).toContain('npm install');
	// A public_id embedded inside a larger code span stays literal — only a
	// whole-span id is rewritten.
	expect(codes).toContain('git status 20260618030521');
});

test('a fenced code block is never rewritten', () => {
	const { container } = renderMd(['```', PUBLIC_ID, '```'].join('\n'));
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
	expect(container.querySelector('pre')?.textContent).toContain(PUBLIC_ID);
});

test('isCommentPublicId validates the timestamp shape', () => {
	expect(isCommentPublicId(PUBLIC_ID)).toBe(true);
	expect(isCommentPublicId(`${PUBLIC_ID}-3`)).toBe(true);
	expect(isCommentPublicId('20261309030521')).toBe(false); // month 13
	expect(isCommentPublicId('20260618306021')).toBe(false); // minute 60
	expect(isCommentPublicId('19990618030521')).toBe(false); // year < 2000
	expect(isCommentPublicId('1234')).toBe(false);
	expect(isCommentPublicId('not-a-number')).toBe(false);
});

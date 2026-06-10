import { render } from '@testing-library/react';
import Markdown from 'react-markdown';
import { expect, test } from 'vitest';
import { remarkMentions } from '../src/lib/remark-mentions';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function renderMarkdown(
	text: string,
	tasks = new Map([['in-42', { title: 'Build paste form', projectSlug: 'demo' }]]),
) {
	return render(
		<Markdown
			remarkPlugins={[
				[
					remarkMentions,
					{
						projectId: 'demo-project',
						projectSlug: 'demo',
						agents: new Map(),
						tasks,
						kbDocs: new Map(),
						projectDocs: new Map(),
						assets: new Map(),
					},
				],
			]}
		>
			{text}
		</Markdown>,
	);
}

test('IN-42#comment-<uuid> renders a comment link to the task + comment hash', () => {
	const { container } = renderMarkdown(`See IN-42#comment-${UUID} for the form.`);
	const link = container.querySelector('a[data-mention-comment-id]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('data-mention-comment-id')).toBe(UUID);
	expect(link?.getAttribute('data-mention-comment-task-identifier')).toBe('in-42');
	expect(link?.getAttribute('data-mention-comment-project-slug')).toBe('demo');
	expect(link?.getAttribute('href')).toBe(`/projects/demo/tasks/in-42#comment-${UUID}`);
	expect(link?.textContent).toBe(`IN-42#comment-${UUID}`);
	// It must NOT also be picked up by the bare-task branch.
	expect(container.querySelector('a[data-mention-task-identifier]')).toBeNull();
});

test('bare IN-42 (no #comment) still renders a normal task link', () => {
	const { container } = renderMarkdown('See IN-42 for details.');
	const link = container.querySelector('a[data-mention-task-identifier]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('data-mention-task-identifier')).toBe('in-42');
	expect(link?.getAttribute('href')).toBe('/projects/demo/tasks/in-42');
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
});

test('IN-42#comment-<non-uuid> is not a comment link, but the IN-42 prefix is still a task link', () => {
	const { container } = renderMarkdown('Try IN-42#comment-not-a-uuid here.');
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
	const taskLink = container.querySelector('a[data-mention-task-identifier]');
	expect(taskLink).not.toBeNull();
	expect(taskLink?.getAttribute('data-mention-task-identifier')).toBe('in-42');
});

test('a comment link to an unresolved task renders as plain text', () => {
	const { container } = renderMarkdown(`See ZZ-99#comment-${UUID}.`, new Map());
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
	expect(container.textContent).toContain(`ZZ-99#comment-${UUID}`);
});

test('a comment link inside inline code is not linked', () => {
	const { container } = renderMarkdown(`Use \`IN-42#comment-${UUID}\` literally.`);
	expect(container.querySelector('a[data-mention-comment-id]')).toBeNull();
});

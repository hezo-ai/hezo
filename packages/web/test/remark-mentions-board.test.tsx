import { render } from '@testing-library/react';
import Markdown from 'react-markdown';
import { expect, test } from 'vitest';
import { remarkMentions } from '../src/lib/remark-mentions';

interface RenderOptions {
	teamId?: string;
}

function renderMarkdown(text: string, opts: RenderOptions = {}) {
	const teamId = opts.teamId ?? 'demo-team';
	return render(
		<Markdown
			remarkPlugins={[
				[
					remarkMentions,
					{
						teamId,
						agents: new Map(),
						tasks: new Map(),
						kbDocs: new Map(),
						projectDocs: new Map(),
					},
				],
			]}
		>
			{text}
		</Markdown>,
	);
}

test('@board renders as a link to the team inbox with data-mention-board="true"', () => {
	const { container } = renderMarkdown('@board please confirm.');
	const link = container.querySelector('a[data-mention-board="true"]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('href')).toBe('/teams/demo-team/inbox');
	expect(link?.textContent).toBe('@board');
	expect(link?.getAttribute('data-mention-passive')).toBeNull();
});

test('@@board renders the passive variant', () => {
	const { container } = renderMarkdown('Board approved — @@board.');
	const link = container.querySelector('a[data-mention-board="true"]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('data-mention-passive')).toBe('true');
});

test('@board inside a code fence is not linked', () => {
	const { container } = renderMarkdown('```\n@board hi\n```');
	expect(container.querySelector('a[data-mention-board="true"]')).toBeNull();
});

test('@board inside inline code is not linked', () => {
	const { container } = renderMarkdown('Mention syntax is `@board` literally.');
	expect(container.querySelector('a[data-mention-board="true"]')).toBeNull();
});

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

test('@admin renders as a link to the team inbox with data-mention-admin="true"', () => {
	const { container } = renderMarkdown('@admin please confirm.');
	const link = container.querySelector('a[data-mention-admin="true"]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('href')).toBe('/teams/demo-team/inbox');
	expect(link?.textContent).toBe('@admin');
	expect(link?.getAttribute('data-mention-passive')).toBeNull();
});

test('@@admin renders the passive variant', () => {
	const { container } = renderMarkdown('Admin approved — @@admin.');
	const link = container.querySelector('a[data-mention-admin="true"]');
	expect(link).not.toBeNull();
	expect(link?.getAttribute('data-mention-passive')).toBe('true');
});

test('@admin inside a code fence is not linked', () => {
	const { container } = renderMarkdown('```\n@admin hi\n```');
	expect(container.querySelector('a[data-mention-admin="true"]')).toBeNull();
});

test('@admin inside inline code is not linked', () => {
	const { container } = renderMarkdown('Mention syntax is `@admin` literally.');
	expect(container.querySelector('a[data-mention-admin="true"]')).toBeNull();
});

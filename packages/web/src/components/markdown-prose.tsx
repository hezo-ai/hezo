import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgents } from '../hooks/use-agents';
import { remarkAgentMentions } from '../lib/remark-agent-mentions';

type RemarkPlugin = Parameters<typeof Markdown>[0]['remarkPlugins'];

const PROSE_CLASSES =
	'prose prose-sm max-w-none text-sm text-text [&_a]:text-accent-blue-text [&_h1]:text-text [&_h2]:text-text [&_h3]:text-text [&_h4]:text-text [&_strong]:text-text [&_code]:text-accent-blue-text [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-muted [&_pre]:border [&_pre]:border-border [&_p:last-child]:mb-0 [&_p:first-child]:mt-0';

const MENTION_CLASSES = 'font-semibold text-[1.05em] text-accent-blue-text hover:underline';

interface MarkdownProseProps {
	children: string;
	testId?: string;
	className?: string;
	companyId?: string;
}

export function MarkdownProse({ children, testId, className, companyId }: MarkdownProseProps) {
	const { data: agents } = useAgents(companyId ?? '');

	const remarkPlugins = useMemo<RemarkPlugin>(() => {
		const plugins: NonNullable<RemarkPlugin> = [remarkGfm];
		if (companyId && agents && agents.length > 0) {
			const slugs = new Set(agents.map((a) => a.slug.toLowerCase()));
			plugins.push([remarkAgentMentions, { companyId, agentSlugs: slugs }]);
		}
		return plugins;
	}, [companyId, agents]);

	const components = useMemo<Components>(
		() => ({
			a: (props) => {
				const mentionSlug = (props as { 'data-mention-agent-slug'?: string })[
					'data-mention-agent-slug'
				];
				if (mentionSlug && companyId) {
					return (
						<Link
							to="/companies/$companyId/agents/$agentId"
							params={{ companyId, agentId: mentionSlug }}
							className={MENTION_CLASSES}
							data-testid="agent-mention-link"
						>
							{props.children}
						</Link>
					);
				}
				return (
					<a href={props.href} target="_blank" rel="noopener noreferrer">
						{props.children}
					</a>
				);
			},
		}),
		[companyId],
	);

	return (
		<div
			className={className ? `${PROSE_CLASSES} ${className}` : PROSE_CLASSES}
			data-testid={testId}
		>
			<Markdown remarkPlugins={remarkPlugins} components={components}>
				{children}
			</Markdown>
		</div>
	);
}

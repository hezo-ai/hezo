import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgents } from '../hooks/use-agents';
import { useIssueMentions } from '../hooks/use-issues';
import {
	type AgentMentionData,
	extractIssueCandidates,
	type IssueMentionData,
	remarkMentions,
} from '../lib/remark-mentions';
import { Tooltip } from './ui/tooltip';

type RemarkPlugin = Parameters<typeof Markdown>[0]['remarkPlugins'];

const PROSE_CLASSES =
	'prose prose-sm max-w-none text-sm text-text [&_a]:text-accent-blue-text [&_h1]:text-text [&_h2]:text-text [&_h3]:text-text [&_h4]:text-text [&_strong]:text-text [&_code]:text-accent-blue-text [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-muted [&_pre]:border [&_pre]:border-border [&_p:last-child]:mb-0 [&_p:first-child]:mt-0 [&_hr]:my-6';

const MENTION_CLASSES = 'font-semibold text-[1.05em] text-accent-blue-text hover:underline';

interface MarkdownProseProps {
	children: string;
	testId?: string;
	className?: string;
	companyId?: string;
}

export function MarkdownProse({ children, testId, className, companyId }: MarkdownProseProps) {
	const { data: agents } = useAgents(companyId ?? '');
	const issueCandidates = useMemo(() => extractIssueCandidates(children), [children]);
	const { data: resolvedIssues } = useIssueMentions(companyId ?? '', issueCandidates);

	const agentsMap = useMemo<Map<string, AgentMentionData>>(() => {
		const m = new Map<string, AgentMentionData>();
		if (!agents) return m;
		for (const a of agents) m.set(a.slug.toLowerCase(), { title: a.title });
		return m;
	}, [agents]);

	const issuesMap = useMemo<Map<string, IssueMentionData>>(() => {
		const m = new Map<string, IssueMentionData>();
		if (!resolvedIssues) return m;
		for (const i of resolvedIssues) {
			m.set(i.identifier.toLowerCase(), { title: i.title, projectSlug: i.project_slug });
		}
		return m;
	}, [resolvedIssues]);

	const remarkPlugins = useMemo<RemarkPlugin>(() => {
		const plugins: NonNullable<RemarkPlugin> = [remarkGfm];
		if (companyId && (agentsMap.size > 0 || issuesMap.size > 0)) {
			plugins.push([remarkMentions, { companyId, agents: agentsMap, issues: issuesMap }]);
		}
		return plugins;
	}, [companyId, agentsMap, issuesMap]);

	const components = useMemo<Components>(
		() => ({
			a: (props) => {
				const attrs = props as {
					'data-mention-agent-slug'?: string;
					'data-mention-agent-title'?: string;
					'data-mention-issue-identifier'?: string;
					'data-mention-issue-title'?: string;
					'data-mention-project-slug'?: string;
				};
				const issueIdentifier = attrs['data-mention-issue-identifier'];
				const issueTitle = attrs['data-mention-issue-title'];
				const projectSlug = attrs['data-mention-project-slug'];
				if (issueIdentifier && issueTitle && projectSlug && companyId) {
					return (
						<Tooltip content={issueTitle}>
							<Link
								to="/companies/$companyId/projects/$projectId/issues/$issueId"
								params={{
									companyId,
									projectId: projectSlug,
									issueId: issueIdentifier.toLowerCase(),
								}}
								className={MENTION_CLASSES}
								data-testid="issue-mention-link"
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				const agentSlug = attrs['data-mention-agent-slug'];
				const agentTitle = attrs['data-mention-agent-title'];
				if (agentSlug && companyId) {
					return (
						<Tooltip content={agentTitle ?? `@${agentSlug}`}>
							<Link
								to="/companies/$companyId/agents/$agentId"
								params={{ companyId, agentId: agentSlug }}
								className={MENTION_CLASSES}
								data-testid="agent-mention-link"
							>
								{props.children}
							</Link>
						</Tooltip>
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

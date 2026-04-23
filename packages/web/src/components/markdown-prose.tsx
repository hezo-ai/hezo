import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgents } from '../hooks/use-agents';
import { useIssueMentions } from '../hooks/use-issues';
import { useDocMentions } from '../hooks/use-mentions';
import {
	type AgentMentionData,
	extractDocCandidates,
	extractIssueCandidates,
	type IssueMentionData,
	type KbDocMentionData,
	type ProjectDocMentionData,
	type ProjectDocsMap,
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
	projectSlug?: string;
}

export function MarkdownProse({
	children,
	testId,
	className,
	companyId,
	projectSlug,
}: MarkdownProseProps) {
	const { data: agents } = useAgents(companyId ?? '');
	const issueCandidates = useMemo(() => extractIssueCandidates(children), [children]);
	const { data: resolvedIssues } = useIssueMentions(companyId ?? '', issueCandidates);
	const docCandidates = useMemo(
		() => extractDocCandidates(children, projectSlug),
		[children, projectSlug],
	);
	const { data: resolvedDocs } = useDocMentions(companyId ?? '', docCandidates);

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

	const kbDocsMap = useMemo<Map<string, KbDocMentionData>>(() => {
		const m = new Map<string, KbDocMentionData>();
		if (!resolvedDocs) return m;
		for (const d of resolvedDocs.kb_docs) {
			m.set(d.slug.toLowerCase(), { title: d.title, size: d.size, updatedAt: d.updated_at });
		}
		return m;
	}, [resolvedDocs]);

	const projectDocsMap = useMemo<ProjectDocsMap>(() => {
		const m: ProjectDocsMap = new Map();
		if (!resolvedDocs) return m;
		for (const d of resolvedDocs.project_docs) {
			const slug = d.project_slug.toLowerCase();
			let perProject = m.get(slug);
			if (!perProject) {
				perProject = new Map<string, ProjectDocMentionData>();
				m.set(slug, perProject);
			}
			perProject.set(d.filename, { size: d.size, updatedAt: d.updated_at });
		}
		return m;
	}, [resolvedDocs]);

	const remarkPlugins = useMemo<RemarkPlugin>(() => {
		const plugins: NonNullable<RemarkPlugin> = [remarkGfm];
		if (
			companyId &&
			(agentsMap.size > 0 || issuesMap.size > 0 || kbDocsMap.size > 0 || projectDocsMap.size > 0)
		) {
			plugins.push([
				remarkMentions,
				{
					companyId,
					projectSlug,
					agents: agentsMap,
					issues: issuesMap,
					kbDocs: kbDocsMap,
					projectDocs: projectDocsMap,
				},
			]);
		}
		return plugins;
	}, [companyId, projectSlug, agentsMap, issuesMap, kbDocsMap, projectDocsMap]);

	const components = useMemo<Components>(
		() => ({
			a: (props) => {
				const attrs = props as {
					'data-mention-agent-slug'?: string;
					'data-mention-agent-title'?: string;
					'data-mention-issue-identifier'?: string;
					'data-mention-issue-title'?: string;
					'data-mention-project-slug'?: string;
					'data-mention-kb-slug'?: string;
					'data-mention-kb-title'?: string;
					'data-mention-doc-project-slug'?: string;
					'data-mention-doc-filename'?: string;
					'data-mention-size'?: string;
					'data-mention-updated-at'?: string;
				};

				const kbSlug = attrs['data-mention-kb-slug'];
				const kbTitle = attrs['data-mention-kb-title'];
				if (kbSlug && kbTitle && companyId) {
					return (
						<Tooltip
							content={
								<DocTooltipContent
									title={kbTitle}
									size={Number(attrs['data-mention-size'] ?? 0)}
									updatedAt={attrs['data-mention-updated-at'] ?? ''}
								/>
							}
						>
							<Link
								to="/companies/$companyId/kb"
								params={{ companyId }}
								search={{ slug: kbSlug }}
								className={MENTION_CLASSES}
								data-testid="kb-mention-link"
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				const docProject = attrs['data-mention-doc-project-slug'];
				const docFilename = attrs['data-mention-doc-filename'];
				if (docProject && docFilename && companyId) {
					return (
						<Tooltip
							content={
								<DocTooltipContent
									title={docFilename}
									size={Number(attrs['data-mention-size'] ?? 0)}
									updatedAt={attrs['data-mention-updated-at'] ?? ''}
								/>
							}
						>
							<Link
								to="/companies/$companyId/projects/$projectId/documents"
								params={{ companyId, projectId: docProject }}
								search={{ file: docFilename }}
								className={MENTION_CLASSES}
								data-testid="doc-mention-link"
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				const issueIdentifier = attrs['data-mention-issue-identifier'];
				const issueTitle = attrs['data-mention-issue-title'];
				const issueProjectSlug = attrs['data-mention-project-slug'];
				if (issueIdentifier && issueTitle && issueProjectSlug && companyId) {
					return (
						<Tooltip content={issueTitle}>
							<Link
								to="/companies/$companyId/projects/$projectId/issues/$issueId"
								params={{
									companyId,
									projectId: issueProjectSlug,
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

function DocTooltipContent({
	title,
	size,
	updatedAt,
}: {
	title: string;
	size: number;
	updatedAt: string;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="font-semibold">{title}</span>
			<span className="opacity-70">
				{formatSize(size)} · updated {formatRelative(updatedAt)}
			</span>
		</div>
	);
}

function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	['year', 60 * 60 * 24 * 365],
	['month', 60 * 60 * 24 * 30],
	['week', 60 * 60 * 24 * 7],
	['day', 60 * 60 * 24],
	['hour', 60 * 60],
	['minute', 60],
	['second', 1],
];

function formatRelative(iso: string): string {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const deltaSeconds = Math.round((then - Date.now()) / 1000);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	for (const [unit, secondsPerUnit] of RELATIVE_UNITS) {
		if (Math.abs(deltaSeconds) >= secondsPerUnit || unit === 'second') {
			return rtf.format(Math.round(deltaSeconds / secondsPerUnit), unit);
		}
	}
	return '';
}

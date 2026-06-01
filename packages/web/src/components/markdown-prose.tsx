import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgents } from '../hooks/use-agents';
import { useDocMentions } from '../hooks/use-mentions';
import { useTaskMentions } from '../hooks/use-tasks';
import { docPreviewPath } from '../lib/doc-preview';
import {
	type AgentMentionData,
	extractDocCandidates,
	extractTaskCandidates,
	type KbDocMentionData,
	type ProjectDocMentionData,
	type ProjectDocsMap,
	remarkMentions,
	type TaskMentionData,
} from '../lib/remark-mentions';
import { Tooltip } from './ui/tooltip';

type RemarkPlugin = Parameters<typeof Markdown>[0]['remarkPlugins'];

const PROSE_CLASSES =
	'prose prose-sm max-w-none text-sm text-text [&_a]:text-accent-blue-text [&_h1]:text-text [&_h2]:text-text [&_h3]:text-text [&_h4]:text-text [&_strong]:text-text [&_code]:text-accent-blue-text [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-muted [&_pre]:border [&_pre]:border-border [&_blockquote]:text-text [&_blockquote]:border-l-border-hover [&_blockquote_p]:text-text [&_p:last-child]:mb-0 [&_p:first-child]:mt-0 [&_hr]:my-6';

const MENTION_CLASSES = 'font-semibold text-[1.05em] text-accent-blue-text hover:underline';

interface MarkdownProseProps {
	children: string;
	testId?: string;
	className?: string;
	teamId?: string;
	projectSlug?: string;
}

export function MarkdownProse({
	children,
	testId,
	className,
	teamId,
	projectSlug,
}: MarkdownProseProps) {
	const { data: agents } = useAgents(teamId ?? '');
	const taskCandidates = useMemo(() => extractTaskCandidates(children), [children]);
	const { data: resolvedTasks } = useTaskMentions(teamId ?? '', taskCandidates);
	const docCandidates = useMemo(
		() => extractDocCandidates(children, projectSlug),
		[children, projectSlug],
	);
	const { data: resolvedDocs } = useDocMentions(teamId ?? '', docCandidates);

	const agentsMap = useMemo<Map<string, AgentMentionData>>(() => {
		const m = new Map<string, AgentMentionData>();
		if (!agents) return m;
		for (const a of agents) m.set(a.slug.toLowerCase(), { title: a.title });
		return m;
	}, [agents]);

	const tasksMap = useMemo<Map<string, TaskMentionData>>(() => {
		const m = new Map<string, TaskMentionData>();
		if (!resolvedTasks) return m;
		for (const i of resolvedTasks) {
			m.set(i.identifier.toLowerCase(), { title: i.title, projectSlug: i.project_slug });
		}
		return m;
	}, [resolvedTasks]);

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
			teamId &&
			(agentsMap.size > 0 || tasksMap.size > 0 || kbDocsMap.size > 0 || projectDocsMap.size > 0)
		) {
			plugins.push([
				remarkMentions,
				{
					teamId,
					projectSlug,
					agents: agentsMap,
					tasks: tasksMap,
					kbDocs: kbDocsMap,
					projectDocs: projectDocsMap,
				},
			]);
		}
		return plugins;
	}, [teamId, projectSlug, agentsMap, tasksMap, kbDocsMap, projectDocsMap]);

	const components = useMemo<Components>(
		() => ({
			a: (props) => {
				const attrs = props as {
					'data-mention-agent-slug'?: string;
					'data-mention-agent-title'?: string;
					'data-mention-passive'?: string;
					'data-mention-task-identifier'?: string;
					'data-mention-task-title'?: string;
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
				if (kbSlug && kbTitle && teamId) {
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
								to="/teams/$teamId/skills"
								params={{ teamId }}
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
				if (docProject && docFilename && teamId) {
					return (
						<span className="inline-flex items-baseline gap-0.5">
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
									to="/teams/$teamId/projects/$projectId/documents"
									params={{ teamId, projectId: docProject }}
									search={{ file: docFilename }}
									className={MENTION_CLASSES}
									data-testid="doc-mention-link"
								>
									{props.children}
								</Link>
							</Tooltip>
							<a
								href={docPreviewPath(teamId, docProject, docFilename)}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Open preview in new tab"
								data-testid="doc-mention-preview-link"
								className="text-accent-blue-text hover:underline"
							>
								<ExternalLink className="w-3 h-3" />
							</a>
						</span>
					);
				}

				const taskIdentifier = attrs['data-mention-task-identifier'];
				const taskTitle = attrs['data-mention-task-title'];
				const taskProjectSlug = attrs['data-mention-project-slug'];
				if (taskIdentifier && taskTitle && taskProjectSlug && teamId) {
					return (
						<Tooltip content={taskTitle}>
							<Link
								to="/teams/$teamId/projects/$projectId/tasks/$taskId"
								params={{
									teamId,
									projectId: taskProjectSlug,
									taskId: taskIdentifier.toLowerCase(),
								}}
								className={MENTION_CLASSES}
								data-testid="task-mention-link"
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				const agentSlug = attrs['data-mention-agent-slug'];
				const agentTitle = attrs['data-mention-agent-title'];
				const agentPassive = attrs['data-mention-passive'] === 'true';
				if (agentSlug && teamId) {
					return (
						<Tooltip content={agentTitle ?? `@${agentSlug}`}>
							<Link
								to="/teams/$teamId/agents/$agentId"
								params={{ teamId, agentId: agentSlug }}
								className={MENTION_CLASSES}
								data-testid="agent-mention-link"
								data-mention-passive={agentPassive ? 'true' : undefined}
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
		[teamId],
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

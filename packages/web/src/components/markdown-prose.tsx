import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgents } from '../hooks/use-agents';
import { useDocMentions, useInstanceMentions } from '../hooks/use-mentions';
import { useTaskMentions } from '../hooks/use-tasks';
import { docPreviewPath } from '../lib/doc-preview';
import {
	type AgentMentionData,
	type AssetMentionData,
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
	projectId?: string;
	projectSlug?: string;
	/**
	 * Instance scope (the global CEO chat): mentions resolve across every
	 * project via /api/mentions/resolve instead of the project-scoped
	 * endpoints; only instance-unique references become links. Mutually
	 * exclusive with `projectId`.
	 */
	instance?: boolean;
}

export function MarkdownProse({
	children,
	testId,
	className,
	projectId,
	projectSlug,
	instance,
}: MarkdownProseProps) {
	const { data: agents } = useAgents(projectId ?? '');
	const taskCandidates = useMemo(() => extractTaskCandidates(children), [children]);
	const { data: resolvedTasks } = useTaskMentions(projectId ?? '', taskCandidates);
	const docCandidates = useMemo(
		() => extractDocCandidates(children, projectSlug),
		[children, projectSlug],
	);
	const { data: resolvedDocs } = useDocMentions(projectId ?? '', docCandidates);
	const { data: instanceResolved } = useInstanceMentions(children, instance === true && !projectId);

	const agentsMap = useMemo<Map<string, AgentMentionData>>(() => {
		const m = new Map<string, AgentMentionData>();
		if (instanceResolved) {
			for (const a of instanceResolved.agents) {
				m.set(a.slug.toLowerCase(), { title: a.title, projectSlug: a.project_slug });
			}
			return m;
		}
		if (!agents) return m;
		for (const a of agents) m.set(a.slug.toLowerCase(), { title: a.title });
		return m;
	}, [agents, instanceResolved]);

	const tasksMap = useMemo<Map<string, TaskMentionData>>(() => {
		const m = new Map<string, TaskMentionData>();
		const source = instanceResolved?.tasks ?? resolvedTasks;
		if (!source) return m;
		for (const i of source) {
			m.set(i.identifier.toLowerCase(), { title: i.title, projectSlug: i.project_slug });
		}
		return m;
	}, [resolvedTasks, instanceResolved]);

	const kbDocsMap = useMemo<Map<string, KbDocMentionData>>(() => {
		const m = new Map<string, KbDocMentionData>();
		const source = instanceResolved?.kb_docs ?? resolvedDocs?.kb_docs;
		if (!source) return m;
		for (const d of source) {
			m.set(d.slug.toLowerCase(), { title: d.title, size: d.size, updatedAt: d.updated_at });
		}
		return m;
	}, [resolvedDocs, instanceResolved]);

	const projectDocsMap = useMemo<ProjectDocsMap>(() => {
		const m: ProjectDocsMap = new Map();
		const source = instanceResolved?.project_docs ?? resolvedDocs?.project_docs;
		if (!source) return m;
		for (const d of source) {
			const slug = d.project_slug.toLowerCase();
			let perProject = m.get(slug);
			if (!perProject) {
				perProject = new Map<string, ProjectDocMentionData>();
				m.set(slug, perProject);
			}
			perProject.set(d.filename, { size: d.size, updatedAt: d.updated_at });
		}
		return m;
	}, [resolvedDocs, instanceResolved]);

	const assetsMap = useMemo<Map<string, AssetMentionData>>(() => {
		const m = new Map<string, AssetMentionData>();
		const source = instanceResolved?.assets ?? resolvedDocs?.assets;
		if (!source) return m;
		for (const a of source) {
			m.set(a.filename, {
				id: a.id,
				contentType: a.content_type,
				signedUrl: a.signed_url,
				projectSlug: a.project_slug,
			});
		}
		return m;
	}, [resolvedDocs, instanceResolved]);

	const remarkPlugins = useMemo<RemarkPlugin>(() => {
		const plugins: NonNullable<RemarkPlugin> = [remarkGfm];
		if (
			(projectId || instance) &&
			(agentsMap.size > 0 ||
				tasksMap.size > 0 ||
				kbDocsMap.size > 0 ||
				projectDocsMap.size > 0 ||
				assetsMap.size > 0)
		) {
			plugins.push([
				remarkMentions,
				{
					projectId,
					projectSlug,
					instance,
					agents: agentsMap,
					tasks: tasksMap,
					kbDocs: kbDocsMap,
					projectDocs: projectDocsMap,
					assets: assetsMap,
				},
			]);
		}
		return plugins;
	}, [projectId, projectSlug, instance, agentsMap, tasksMap, kbDocsMap, projectDocsMap, assetsMap]);

	const components = useMemo<Components>(() => {
		// Mention links render whenever a scope is active: project scope carries
		// the route's projectId; instance scope (CEO chat) derives each link's
		// project from the per-entity data attributes instead.
		const mentionsEnabled = Boolean(projectId) || instance === true;
		return {
			a: (props) => {
				const attrs = props as {
					'data-mention-admin'?: string;
					'data-mention-agent-slug'?: string;
					'data-mention-agent-title'?: string;
					'data-mention-agent-project-slug'?: string;
					'data-mention-passive'?: string;
					'data-mention-task-identifier'?: string;
					'data-mention-task-title'?: string;
					'data-mention-project-slug'?: string;
					'data-mention-comment-task-identifier'?: string;
					'data-mention-comment-id'?: string;
					'data-mention-comment-project-slug'?: string;
					'data-mention-comment-task-title'?: string;
					'data-mention-kb-slug'?: string;
					'data-mention-kb-title'?: string;
					'data-mention-doc-project-slug'?: string;
					'data-mention-doc-filename'?: string;
					'data-mention-asset-project-slug'?: string;
					'data-mention-asset-filename'?: string;
					'data-mention-asset-content-type'?: string;
					'data-mention-asset-url'?: string;
					'data-mention-size'?: string;
					'data-mention-updated-at'?: string;
				};

				const kbSlug = attrs['data-mention-kb-slug'];
				const kbTitle = attrs['data-mention-kb-title'];
				if (kbSlug && kbTitle && mentionsEnabled) {
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
							<Link to="/settings/skills" className={MENTION_CLASSES} data-testid="kb-mention-link">
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				const docProject = attrs['data-mention-doc-project-slug'];
				const docFilename = attrs['data-mention-doc-filename'];
				if (docProject && docFilename && mentionsEnabled) {
					return (
						<DedicatedViewMention
							href={docPreviewPath(docProject, docFilename)}
							nameTestId="doc-mention-link"
							previewTestId="doc-mention-preview-link"
							previewAriaLabel="Open preview in new tab"
							tooltip={
								<DocTooltipContent
									title={docFilename}
									size={Number(attrs['data-mention-size'] ?? 0)}
									updatedAt={attrs['data-mention-updated-at'] ?? ''}
								/>
							}
						>
							{props.children}
						</DedicatedViewMention>
					);
				}

				const assetProject = attrs['data-mention-asset-project-slug'];
				const assetFilename = attrs['data-mention-asset-filename'];
				const assetUrl = attrs['data-mention-asset-url'];
				if (assetProject && assetFilename && mentionsEnabled) {
					if (assetUrl) {
						return (
							<DedicatedViewMention
								href={assetUrl}
								nameTestId="asset-mention-link"
								previewTestId="asset-mention-preview-link"
								previewAriaLabel="Open asset in new tab"
							>
								{props.children}
							</DedicatedViewMention>
						);
					}
					// No signed URL → no dedicated view to open. Keep the same-tab
					// library link with no icon (consistent with the general rule).
					return (
						<Link
							to="/projects/$projectId/assets"
							params={{ projectId: assetProject }}
							search={{ file: assetFilename }}
							className={MENTION_CLASSES}
							data-testid="asset-mention-link"
						>
							{props.children}
						</Link>
					);
				}

				const commentTaskIdentifier = attrs['data-mention-comment-task-identifier'];
				const commentId = attrs['data-mention-comment-id'];
				const commentProjectSlug = attrs['data-mention-comment-project-slug'];
				const commentTaskTitle = attrs['data-mention-comment-task-title'];
				if (commentTaskIdentifier && commentId && commentProjectSlug && mentionsEnabled) {
					return (
						<Tooltip
							content={`Comment in ${commentTaskIdentifier.toUpperCase()}${commentTaskTitle ? ` — ${commentTaskTitle}` : ''}`}
						>
							<Link
								to="/projects/$projectId/tasks/$taskId"
								params={{
									projectId: commentProjectSlug,
									taskId: commentTaskIdentifier.toLowerCase(),
								}}
								hash={`comment-${commentId}`}
								className={MENTION_CLASSES}
								data-testid="comment-mention-link"
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				const taskIdentifier = attrs['data-mention-task-identifier'];
				const taskTitle = attrs['data-mention-task-title'];
				const taskProjectSlug = attrs['data-mention-project-slug'];
				if (taskIdentifier && taskTitle && taskProjectSlug && mentionsEnabled) {
					return (
						<Tooltip content={taskTitle}>
							<Link
								to="/projects/$projectId/tasks/$taskId"
								params={{
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
				const agentProjectSlug = attrs['data-mention-agent-project-slug'] ?? projectId;
				if (agentSlug && agentProjectSlug && mentionsEnabled) {
					return (
						<Tooltip content={agentTitle ?? `@${agentSlug}`}>
							<Link
								to="/projects/$projectId/agents/$agentId"
								params={{ projectId: agentProjectSlug, agentId: agentSlug }}
								className={MENTION_CLASSES}
								data-testid="agent-mention-link"
								data-mention-passive={agentPassive ? 'true' : undefined}
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				if (attrs['data-mention-admin'] === 'true' && mentionsEnabled) {
					const adminLink = projectId ? (
						<Link
							to="/projects/$projectId/inbox"
							params={{ projectId }}
							className={MENTION_CLASSES}
							data-testid="admin-mention-link"
						>
							{props.children}
						</Link>
					) : (
						<Link to="/home/inbox" className={MENTION_CLASSES} data-testid="admin-mention-link">
							{props.children}
						</Link>
					);
					return <Tooltip content="Admin inbox">{adminLink}</Tooltip>;
				}

				return (
					<a href={props.href} target="_blank" rel="noopener noreferrer">
						{props.children}
					</a>
				);
			},
		};
	}, [projectId, instance]);

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

/**
 * A mention whose name and trailing icon both open the same dedicated view in a
 * new tab. The icon suffix is the visual marker for "this link opens a new tab",
 * so it is rendered here and only here — same-tab in-app mentions never use this
 * component and therefore never get the icon.
 */
function DedicatedViewMention({
	href,
	children,
	nameTestId,
	previewTestId,
	previewAriaLabel,
	tooltip,
}: {
	href: string;
	children: ReactNode;
	nameTestId: string;
	previewTestId: string;
	previewAriaLabel: string;
	tooltip?: ReactNode;
}) {
	const name = (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className={MENTION_CLASSES}
			data-testid={nameTestId}
		>
			{children}
		</a>
	);
	return (
		<span className="inline-flex items-baseline gap-0.5">
			{tooltip ? <Tooltip content={tooltip}>{name}</Tooltip> : name}
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={previewAriaLabel}
				data-testid={previewTestId}
				className="text-accent-blue-text hover:underline"
			>
				<ExternalLink className="w-3 h-3" />
			</a>
		</span>
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

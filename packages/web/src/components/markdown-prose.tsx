import { TERMINAL_TASK_STATUSES } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgents } from '../hooks/use-agents';
import { useDocMentions, useInstanceMentions } from '../hooks/use-mentions';
import { useTaskMentions } from '../hooks/use-tasks';
import { docPreviewPath } from '../lib/doc-preview';
import { formatRelativeTime } from '../lib/format-date';
import { type ReviewAnnotation, rehypeReviewHighlights } from '../lib/rehype-review-highlights';
import { type CommentRefTask, remarkCommentRefs } from '../lib/remark-comment-refs';
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
import { remarkNormalizeInlineCode } from '../lib/remark-normalize-inline-code';
import { CommentRefLink, MENTION_CLASSES, PASSIVE_MENTION_CLASSES } from './comment-ref-link';
import { MarkdownCodeBlock } from './markdown-code-block';
import { useOpenPreview } from './task-detail/preview-context';
import { TaskMentionTooltipContent } from './task-mention-tooltip';
import { Tooltip } from './ui/tooltip';

type RemarkPlugin = Parameters<typeof Markdown>[0]['remarkPlugins'];
type RehypePlugin = Parameters<typeof Markdown>[0]['rehypePlugins'];

// Exported for the plain-text review surface (asset viewer), which renders the
// same `mark[data-review-id]` highlights without going through react-markdown.
export const REVIEW_MARK_CLASSES =
	'cursor-pointer rounded-[3px] px-px bg-accent/15 text-text-1 transition-colors hover:bg-accent/25 [box-shadow:inset_0_-1.5px_0_0_color-mix(in_oklab,var(--color-accent)_45%,transparent)]';
export const REVIEW_MARK_ACTIVE_CLASSES =
	'cursor-pointer rounded-[3px] px-px bg-accent/30 text-text-1 ring-2 ring-ring [box-shadow:inset_0_-1.5px_0_0_color-mix(in_oklab,var(--color-accent)_45%,transparent)]';

// break-words wraps long unbreakable strings (URLs, paths) inside the prose
// column instead of widening it; tables opt back out so cell tokens stay whole
// and the table scrolls in its overflow wrapper (see the `table` component).
const PROSE_CLASSES =
	'prose prose-sm max-w-none break-words [&_table]:[overflow-wrap:normal] text-sm text-text-1 [&_a]:text-info-soft-fg [&_h1]:text-text-1 [&_h2]:text-text-1 [&_h3]:text-text-1 [&_h4]:text-text-1 [&_strong]:text-text-1 [&_code]:text-info-soft-fg [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-surface-3 [&_pre]:border [&_pre]:border-border [&_blockquote]:text-text-1 [&_blockquote]:border-l-border-strong [&_blockquote_p]:text-text-1 [&_p:last-child]:mb-0 [&_p:first-child]:mt-0 [&_hr]:my-6';

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
	/**
	 * Agent-run context: links bare/inline-code comment public_ids in the text to
	 * the run's task comment (see remarkCommentRefs). Only set by the formatted
	 * log view.
	 */
	commentRefTask?: CommentRefTask;
	/**
	 * Document-review highlights: each annotation's quote renders wrapped in a
	 * clickable `<mark data-review-id>` (see rehype-review-highlights). Only set
	 * by the review-enabled document view surfaces.
	 */
	reviewAnnotations?: ReviewAnnotation[];
	/** Click handler for a review highlight (open its comment editor). */
	onReviewHighlightClick?: (id: string) => void;
	/** The annotation whose highlight renders in the active (editing) style. */
	activeReviewId?: string | null;
}

export function MarkdownProse({
	children,
	testId,
	className,
	projectId,
	projectSlug,
	instance,
	commentRefTask,
	reviewAnnotations,
	onReviewHighlightClick,
	activeReviewId,
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
	// When the surface hosts a preview panel (task detail), doc mentions open in it;
	// asset mentions always open in a new tab regardless of surface.
	const openPreview = useOpenPreview();

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
			m.set(i.identifier.toLowerCase(), {
				title: i.title,
				projectSlug: i.project_slug,
				status: i.status,
			});
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
				projectSlug: a.project_slug,
			});
		}
		return m;
	}, [resolvedDocs, instanceResolved]);

	const remarkPlugins = useMemo<RemarkPlugin>(() => {
		// remarkNormalizeInlineCode runs first (right after GFM parsing) so an
		// LLM-double-wrapped token like `` `x` `` renders as a clean `x` chip
		// instead of showing its inner backticks, and so the inline-code linkifiers
		// below see the unwrapped value.
		const plugins: NonNullable<RemarkPlugin> = [remarkGfm, remarkNormalizeInlineCode];
		// The plugin also runs when the text carries a passive `@@` mention even if
		// nothing resolved: an unresolved passive mention still needs its internal
		// `@@` prefix stripped to a bare slug (see remark-mentions splitTextNode), so
		// gating purely on resolved-map sizes would leak `@@slug` to the reader.
		const hasPassiveMention = children.includes('@@');
		if (
			(projectId || instance) &&
			(hasPassiveMention ||
				agentsMap.size > 0 ||
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
		// Comment-ref linking runs regardless of resolved @mentions — it only needs
		// the run's task context, which the formatted log view supplies directly.
		if (commentRefTask) plugins.push([remarkCommentRefs, commentRefTask]);
		return plugins;
	}, [
		children,
		projectId,
		projectSlug,
		instance,
		agentsMap,
		tasksMap,
		kbDocsMap,
		projectDocsMap,
		assetsMap,
		commentRefTask,
	]);

	const rehypePlugins = useMemo<RehypePlugin>(() => {
		if (!reviewAnnotations || reviewAnnotations.length === 0) return undefined;
		return [[rehypeReviewHighlights, { annotations: reviewAnnotations }]];
	}, [reviewAnnotations]);

	const components = useMemo<Components>(() => {
		// Mention links render whenever a scope is active: project scope carries
		// the route's projectId; instance scope (CEO chat) derives each link's
		// project from the per-entity data attributes instead.
		const mentionsEnabled = Boolean(projectId) || instance === true;
		return {
			mark: (props) => {
				const attrs = props as { 'data-review-id'?: string; children?: ReactNode };
				const reviewId = attrs['data-review-id'];
				if (!reviewId) return <mark>{props.children}</mark>;
				return (
					// biome-ignore lint/a11y/useSemanticElements: a <button> cannot wrap arbitrary inline prose (invalid nesting, breaks text flow); the mark carries role/tabIndex/keydown instead
					<mark
						data-review-id={reviewId}
						data-testid="review-highlight"
						className={
							reviewId === activeReviewId ? REVIEW_MARK_ACTIVE_CLASSES : REVIEW_MARK_CLASSES
						}
						onClick={() => onReviewHighlightClick?.(reviewId)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onReviewHighlightClick?.(reviewId);
							}
						}}
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the highlight is genuinely interactive (opens its comment editor) and a real <button> cannot wrap inline prose; full keyboard support is provided
						role="button"
						tabIndex={0}
					>
						{props.children}
					</mark>
				);
			},
			a: (props) => {
				const attrs = props as {
					'data-mention-admin'?: string;
					'data-mention-agent-slug'?: string;
					'data-mention-agent-title'?: string;
					'data-mention-agent-project-slug'?: string;
					'data-mention-passive'?: string;
					'data-mention-task-identifier'?: string;
					'data-mention-task-title'?: string;
					'data-mention-task-status'?: string;
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
					const docTooltip = (
						<DocTooltipContent
							title={docFilename}
							size={Number(attrs['data-mention-size'] ?? 0)}
							updatedAt={attrs['data-mention-updated-at'] ?? ''}
						/>
					);
					// In a comment thread (preview panel present) the mention opens the
					// doc in the panel — no separate new-tab icon.
					if (openPreview) {
						return (
							<PreviewMentionButton
								tooltip={docTooltip}
								testId="doc-mention-link"
								onClick={() =>
									openPreview({
										projectId: docProject,
										projectSlug: docProject,
										filename: docFilename,
										size: Number(attrs['data-mention-size'] ?? 0) || undefined,
										updatedAt: attrs['data-mention-updated-at'] || undefined,
									})
								}
							>
								{props.children}
							</PreviewMentionButton>
						);
					}
					return (
						<DedicatedViewMention
							href={docPreviewPath(docProject, docFilename)}
							nameTestId="doc-mention-link"
							previewTestId="doc-mention-preview-link"
							previewAriaLabel="Open preview in new tab"
							tooltip={docTooltip}
						>
							{props.children}
						</DedicatedViewMention>
					);
				}

				const assetProject = attrs['data-mention-asset-project-slug'];
				const assetFilename = attrs['data-mention-asset-filename'];
				if (assetProject && assetFilename && mentionsEnabled) {
					// The in-app viewer is the canonical asset link target (raw view
					// stays reachable from its toolbar); same-tab in-app mentions carry
					// no new-tab icon per the general rule.
					return (
						<Link
							to="/projects/$projectId/assets/view"
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
						<CommentRefLink
							taskIdentifier={commentTaskIdentifier}
							commentId={commentId}
							projectSlug={commentProjectSlug}
							taskTitle={commentTaskTitle}
						>
							{props.children}
						</CommentRefLink>
					);
				}

				const taskIdentifier = attrs['data-mention-task-identifier'];
				const taskTitle = attrs['data-mention-task-title'];
				const taskProjectSlug = attrs['data-mention-project-slug'];
				const taskStatus = attrs['data-mention-task-status'];
				if (taskIdentifier && taskTitle && taskProjectSlug && mentionsEnabled) {
					const closed = taskStatus
						? (TERMINAL_TASK_STATUSES as readonly string[]).includes(taskStatus)
						: false;
					return (
						<Tooltip
							content={
								<TaskMentionTooltipContent
									identifier={taskIdentifier}
									title={taskTitle}
									status={taskStatus}
								/>
							}
						>
							<Link
								to="/projects/$projectId/tasks/$taskId"
								params={{
									projectId: taskProjectSlug,
									taskId: taskIdentifier.toLowerCase(),
								}}
								className={closed ? `${MENTION_CLASSES} line-through` : MENTION_CLASSES}
								data-mention-task-status={taskStatus}
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
								className={agentPassive ? PASSIVE_MENTION_CLASSES : MENTION_CLASSES}
								data-testid="agent-mention-link"
								data-mention-passive={agentPassive ? 'true' : undefined}
							>
								{props.children}
							</Link>
						</Tooltip>
					);
				}

				if (attrs['data-mention-admin'] === 'true' && mentionsEnabled) {
					// `@@admin` is a reference, not an inbox ask — mute it the same way a
					// passive teammate chip is muted, so the thread shows at a glance
					// which mentions actually reached someone.
					const adminClasses = agentPassive ? PASSIVE_MENTION_CLASSES : MENTION_CLASSES;
					const adminLink = projectId ? (
						<Link
							to="/projects/$projectId/inbox"
							params={{ projectId }}
							className={adminClasses}
							data-testid="admin-mention-link"
							data-mention-passive={agentPassive ? 'true' : undefined}
						>
							{props.children}
						</Link>
					) : (
						<Link
							to="/home/inbox"
							className={adminClasses}
							data-testid="admin-mention-link"
							data-mention-passive={agentPassive ? 'true' : undefined}
						>
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
			// A wide table would otherwise widen the prose container itself (tables
			// have no intrinsic overflow handling, unlike `pre`), pushing the whole
			// page into horizontal scroll; the wrapper keeps the scrollbar on the
			// table alone.
			table: (props) => (
				<div className="overflow-x-auto">
					<table>{props.children}</table>
				</div>
			),
			// A fenced code block renders inside a relative wrapper so its copy
			// button can overlay the bottom-right corner without pushing the
			// following content down. Inline `<code>` never reaches this override.
			pre: MarkdownCodeBlock,
		};
	}, [projectId, instance, openPreview, activeReviewId, onReviewHighlightClick]);

	return (
		<div
			className={className ? `${PROSE_CLASSES} ${className}` : PROSE_CLASSES}
			data-testid={testId}
		>
			<Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
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
				className="text-info-soft-fg hover:underline"
			>
				<ExternalLink className="w-3 h-3" />
			</a>
		</span>
	);
}

/**
 * A doc mention that opens in the in-page preview panel rather than a new tab. No
 * trailing external-link icon — the new-tab affordance lives on the panel itself.
 * Used only when a surface provides the preview context.
 */
function PreviewMentionButton({
	onClick,
	tooltip,
	testId,
	children,
}: {
	onClick: () => void;
	tooltip?: ReactNode;
	testId: string;
	children: ReactNode;
}) {
	const button = (
		<button type="button" onClick={onClick} className={MENTION_CLASSES} data-testid={testId}>
			{children}
		</button>
	);
	return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
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
				{formatSize(size)} · updated {formatRelativeTime(updatedAt)}
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

import { formatTaskStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { repoWebUrl } from '../../lib/github';
import { Trans, useI18n } from '../../lib/i18n';
import type {
	SystemContent,
	SystemDescriptionChangeContent,
	SystemParentChangeContent,
	SystemRepoDesignatedContent,
	SystemRunFailedContent,
	SystemStatusChangeContent,
	SystemTaskLinkContent,
} from '../comment-content';
import { ActorBadge } from '../ui/actor-badge';
import type { CommentDataOf } from './comment-data';
import { CommentTimestampLink } from './comment-timestamp-link';

interface Props {
	comment: CommentDataOf<'system'>;
	projectId?: string;
}

function isTaskLink(c: SystemContent): c is SystemTaskLinkContent {
	return c.kind === 'task_link';
}
function isStatusChange(c: SystemContent): c is SystemStatusChangeContent {
	return c.kind === 'status_change';
}
function isRunFailed(c: SystemContent): c is SystemRunFailedContent {
	return c.kind === 'run_failed';
}
function isRepoDesignated(c: SystemContent): c is SystemRepoDesignatedContent {
	return c.kind === 'repo_designated';
}
function isParentChange(c: SystemContent): c is SystemParentChangeContent {
	return c.kind === 'parent_change';
}
function isDescriptionChange(c: SystemContent): c is SystemDescriptionChangeContent {
	return c.kind === 'description_change';
}

export function SystemComment({ comment, projectId }: Props) {
	const content: SystemContent | null =
		comment.content && typeof comment.content === 'object' ? comment.content : null;
	const timestamp = (
		<CommentTimestampLink publicId={comment.public_id} createdAt={comment.created_at} />
	);

	if (content && isTaskLink(content) && projectId) {
		// The sentence gained a clause, so stack the timestamp under it on mobile
		// rather than letting it wrap mid-clause (same idiom as RunFailedBody).
		return (
			<div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]">
				<TaskLinkSystemBody comment={comment} content={content} projectId={projectId} />
				{timestamp}
			</div>
		);
	}

	if (content && isStatusChange(content)) {
		return (
			<StatusChangeBody
				comment={comment}
				content={content}
				projectId={projectId}
				timestamp={timestamp}
			/>
		);
	}

	if (content && isRunFailed(content)) {
		return <RunFailedBody content={content} projectId={projectId} timestamp={timestamp} />;
	}

	if (content && isRepoDesignated(content)) {
		return <RepoDesignatedBody content={content} timestamp={timestamp} />;
	}

	if (content && isParentChange(content)) {
		return <ParentChangeBody comment={comment} content={content} timestamp={timestamp} />;
	}

	if (content && isDescriptionChange(content)) {
		return <DescriptionChangeBody comment={comment} content={content} timestamp={timestamp} />;
	}

	const text = content
		? (content.text ?? JSON.stringify(content))
		: comment.content
			? String(comment.content)
			: '';
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-2">{text}</span>
			<ActorBadge actorType={comment.author_type} name={comment.author_name} />
			{timestamp}
		</div>
	);
}

function StatusChangeBody({
	comment,
	content,
	projectId,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemStatusChangeContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const from = typeof content.from === 'string' ? content.from : '';
	const to = typeof content.to === 'string' ? content.to : '';
	const cascade = typeof content.cascade === 'string' ? content.cascade : null;
	if (cascade === 'auto_unblock' && projectId) {
		const triggeredIdentifier =
			typeof content.triggered_by_identifier === 'string' ? content.triggered_by_identifier : '';
		const triggeredProjectSlug =
			typeof content.triggered_by_project_slug === 'string'
				? content.triggered_by_project_slug
				: '';
		const triggerNode =
			triggeredIdentifier && triggeredProjectSlug ? (
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{
						projectId: triggeredProjectSlug,
						taskId: triggeredIdentifier.toLowerCase(),
					}}
					className="text-xs text-info-soft-fg hover:underline"
					data-testid="cascade-trigger-task"
				>
					{triggeredIdentifier}
				</Link>
			) : (
				<span className="text-xs text-text-2">
					{triggeredIdentifier || t('comment.autoUnblockedFallback')}
				</span>
			);
		return (
			<div className="flex items-baseline gap-2 leading-[26px]" data-testid="status-change-cascade">
				<span className="text-xs text-text-2">
					<Trans k="comment.autoUnblocked" vars={{ trigger: triggerNode }} />
				</span>
				{timestamp}
			</div>
		);
	}
	const actorName = comment.author_name ?? 'Admin';
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-2">
				<Trans
					k="comment.statusChanged"
					vars={{
						actor: actorName,
						from: <em className="italic">{formatTaskStatus(from)}</em>,
						to: <em className="italic">{formatTaskStatus(to)}</em>,
					}}
				/>
			</span>
			<ActorBadge actorType={comment.author_type} name={actorName} />
			{timestamp}
		</div>
	);
}

function ParentChangeBody({
	comment,
	content,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemParentChangeContent;
	timestamp: React.ReactNode;
}) {
	const actorName = comment.author_name ?? 'Admin';

	// The recorder carries each end's project slug so the identifiers can link
	// without a second fetch. An end missing its slug still renders as plain text.
	const end = (identifier?: string | null, projectSlug?: string | null, testId?: string) => {
		if (!identifier) return null;
		if (!projectSlug) return <span className="text-xs text-text-2">{identifier}</span>;
		return (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{ projectId: projectSlug, taskId: identifier.toLowerCase() }}
				className="text-xs text-info-soft-fg hover:underline"
				data-testid={testId}
			>
				{identifier}
			</Link>
		);
	};

	const from = end(content.from_identifier, content.from_project_slug, 'parent-change-from');
	const to = end(content.to_identifier, content.to_project_slug, 'parent-change-to');

	const body =
		from && to ? (
			<Trans k="comment.parentMoved" vars={{ actor: actorName, from, to }} />
		) : to ? (
			<Trans k="comment.parentNested" vars={{ actor: actorName, to }} />
		) : from ? (
			<Trans k="comment.parentPromotedFrom" vars={{ actor: actorName, from }} />
		) : (
			<Trans k="comment.parentPromoted" vars={{ actor: actorName }} />
		);

	return (
		<div className="flex items-baseline gap-2 leading-[26px]" data-testid="parent-change-comment">
			<span className="text-xs text-text-2">{body}</span>
			<ActorBadge actorType={comment.author_type} name={actorName} />
			{timestamp}
		</div>
	);
}

/**
 * A description edit. The payload carries a capped preview of each end rather
 * than the bodies (see `SystemDescriptionChangeContent`), so the expanded view
 * renders them as plain text with a trailing ellipsis where the preview was cut,
 * never as markdown - it is a quote of what changed, not a second copy of the
 * description. Stacked at every breakpoint: this sits inside the narrow
 * inline-event row, so there is no room for side-by-side.
 */
function DescriptionChangeBody({
	comment,
	content,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemDescriptionChangeContent;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState(false);
	const actorName = comment.author_name ?? 'Admin';
	const from = content.from_preview ?? '';
	const to = content.to_preview ?? '';
	const hasPreview = from.length > 0 || to.length > 0;

	const end = (label: string, text: string, truncated: boolean | undefined, testId: string) =>
		text ? (
			<div className="min-w-0">
				<span className="text-[11px] uppercase tracking-wider font-medium text-text-3">
					{label}
				</span>
				<p
					className="mt-0.5 whitespace-pre-wrap break-words text-xs text-text-2"
					data-testid={testId}
				>
					{truncated ? `${text}…` : text}
				</p>
			</div>
		) : null;

	return (
		<div className="flex flex-col gap-1" data-testid="description-change-comment">
			{/* Wraps rather than overflowing: this row carries one more control than
			    its siblings, and it sits in a column that is only ~340px wide on a
			    375px viewport. */}
			<div className="flex flex-wrap items-baseline gap-2 leading-[26px]">
				<span className="min-w-0 text-xs text-text-2">
					{content.text ?? `${actorName} updated the description`}
				</span>
				<ActorBadge actorType={comment.author_type} name={actorName} />
				{timestamp}
				{hasPreview && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
						aria-label={t('tasks.descriptionChange.toggle')}
						title={t('tasks.descriptionChange.toggle')}
						data-testid="description-change-toggle"
						className="shrink-0 text-text-3 hover:text-text-1"
					>
						<ChevronDown
							className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
						/>
					</button>
				)}
			</div>
			{expanded && hasPreview && (
				<div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2">
					{end(
						t('tasks.descriptionChange.before'),
						from,
						content.from_truncated,
						'description-change-before',
					)}
					{end(
						t('tasks.descriptionChange.after'),
						to,
						content.to_truncated,
						'description-change-after',
					)}
				</div>
			)}
		</div>
	);
}

function RunFailedBody({
	content,
	projectId,
	timestamp,
}: {
	content: SystemRunFailedContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const agentSlug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
	const status = typeof content.status === 'string' ? content.status : 'failed';
	const error =
		typeof content.error === 'string' && content.error.length > 0 ? content.error : null;
	const timedOut = status === 'timed_out';
	const agentNode =
		agentSlug && projectId ? (
			<Link
				to="/projects/$projectId/agents/$agentId"
				params={{ projectId, agentId: agentSlug }}
				className="text-xs text-info-soft-fg hover:underline"
				data-testid="run-failed-agent"
			>
				@{agentSlug}
			</Link>
		) : (
			<span className="text-xs text-text-2">{t('comment.runAgentFallback')}</span>
		);
	// Four keys rather than two with a {status} var: the status word inflects with
	// the sentence in several of these languages, so a shared template would force
	// a wrong agreement somewhere.
	const key = error
		? timedOut
			? 'comment.runTimedOutWithError'
			: 'comment.runFailedWithError'
		: timedOut
			? 'comment.runTimedOut'
			: 'comment.runFailed';
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid="run-failed-comment"
		>
			<span className="text-xs text-text-2 inline-flex items-baseline gap-1.5 flex-wrap">
				<span>
					<Trans
						k={key}
						vars={{
							agent: agentNode,
							error: error ? <span className="text-text-3">{error}</span> : null,
						}}
					/>
				</span>
			</span>
			{timestamp}
		</div>
	);
}

function RepoDesignatedBody({
	content,
	timestamp,
}: {
	content: SystemRepoDesignatedContent;
	timestamp: React.ReactNode;
}) {
	const identifier = typeof content.repo_identifier === 'string' ? content.repo_identifier : '';
	const hostType = typeof content.host_type === 'string' ? content.host_type : '';
	const url = identifier ? repoWebUrl(identifier, hostType) : null;
	const repoNode = url ? (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="text-xs text-info-soft-fg hover:underline"
			data-testid="repo-designated-link"
		>
			{identifier}
		</a>
	) : (
		<span className="text-xs text-text-2">{identifier}</span>
	);
	return (
		<div className="flex items-baseline gap-2 leading-[26px]" data-testid="repo-designated-comment">
			<span className="text-xs text-text-2">
				<Trans k="comment.repoDesignated" vars={{ repo: repoNode }} />
			</span>
			{timestamp}
		</div>
	);
}

function TaskLinkSystemBody({
	comment,
	content,
	projectId,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemTaskLinkContent;
	projectId: string;
}) {
	const { t } = useI18n();
	const sourceIdentifier = content.source_identifier ?? '';
	const sourceProjectSlug = content.source_project_slug ?? '';
	const actorName = content.actor_name ?? comment.author_name ?? 'Admin';
	const actorKind = content.actor_kind ?? null;
	const actorSlug = content.actor_slug ?? null;
	const sourceCommentPublicId = content.source_comment_public_id ?? null;

	const linkClass = 'text-xs text-info-soft-fg hover:underline';
	const textClass = 'text-xs text-text-2';

	const sourceNode =
		sourceIdentifier && sourceProjectSlug ? (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{
					projectId: sourceProjectSlug,
					taskId: sourceIdentifier.toLowerCase(),
				}}
				className={linkClass}
				data-testid="task-link-source"
			>
				{sourceIdentifier}
			</Link>
		) : (
			<span className={textClass}>{sourceIdentifier}</span>
		);

	// The mention lived in a comment, so point at that comment rather than only at
	// its task. Same target as CommentRefLink, styled for a grey event row instead
	// of a mention. A description-sourced link has no anchor and stays as it was.
	const commentNode =
		sourceCommentPublicId && sourceIdentifier && sourceProjectSlug ? (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{
					projectId: sourceProjectSlug,
					taskId: sourceIdentifier.toLowerCase(),
				}}
				hash={`comment-${sourceCommentPublicId}`}
				className={linkClass}
				data-testid="task-link-source-comment"
			>
				{t('comment.linkedFromCommentLabel')}
			</Link>
		) : null;

	const actorNode =
		actorKind === 'agent' && actorSlug ? (
			<Link
				to="/projects/$projectId/agents/$agentId"
				params={{ projectId, agentId: actorSlug }}
				className={linkClass}
				data-testid="task-link-actor"
			>
				{actorName}
			</Link>
		) : (
			<span className={textClass}>{actorName}</span>
		);

	return (
		<span className={textClass}>
			<Trans
				k={commentNode ? 'comment.linkedFromComment' : 'comment.linkedFrom'}
				vars={{ comment: commentNode, source: sourceNode, actor: actorNode }}
			/>
			<ActorBadge actorType={comment.author_type} name={actorName} className="ml-1" />
		</span>
	);
}

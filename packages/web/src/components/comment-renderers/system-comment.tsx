import { formatTaskStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { repoWebUrl } from '../../lib/github';
import type {
	SystemContent,
	SystemRepoDesignatedContent,
	SystemRunFailedContent,
	SystemStatusChangeContent,
	SystemTaskLinkContent,
} from '../comment-content';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'system'>;
	teamId?: string;
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

export function SystemComment({ comment, teamId }: Props) {
	const content: SystemContent | null =
		comment.content && typeof comment.content === 'object' ? comment.content : null;
	const timestamp = (
		<span className="text-[11px] text-text-subtle">
			{new Date(comment.created_at).toLocaleString()}
		</span>
	);

	if (content && isTaskLink(content) && teamId) {
		return (
			<div className="flex items-baseline gap-2 leading-[26px]">
				<TaskLinkSystemBody comment={comment} content={content} teamId={teamId} />
				{timestamp}
			</div>
		);
	}

	if (content && isStatusChange(content)) {
		return (
			<StatusChangeBody comment={comment} content={content} teamId={teamId} timestamp={timestamp} />
		);
	}

	if (content && isRunFailed(content)) {
		return <RunFailedBody content={content} teamId={teamId} timestamp={timestamp} />;
	}

	if (content && isRepoDesignated(content)) {
		return <RepoDesignatedBody content={content} timestamp={timestamp} />;
	}

	const text = content
		? (content.text ?? JSON.stringify(content))
		: comment.content
			? String(comment.content)
			: '';
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-muted">{text}</span>
			{timestamp}
		</div>
	);
}

function StatusChangeBody({
	comment,
	content,
	teamId,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemStatusChangeContent;
	teamId?: string;
	timestamp: React.ReactNode;
}) {
	const from = typeof content.from === 'string' ? content.from : '';
	const to = typeof content.to === 'string' ? content.to : '';
	const cascade = typeof content.cascade === 'string' ? content.cascade : null;
	if (cascade === 'auto_unblock' && teamId) {
		const triggeredIdentifier =
			typeof content.triggered_by_identifier === 'string' ? content.triggered_by_identifier : '';
		const triggeredProjectSlug =
			typeof content.triggered_by_project_slug === 'string'
				? content.triggered_by_project_slug
				: '';
		const triggerNode =
			triggeredIdentifier && triggeredProjectSlug ? (
				<Link
					to="/teams/$teamId/projects/$projectId/tasks/$taskId"
					params={{
						teamId,
						projectId: triggeredProjectSlug,
						taskId: triggeredIdentifier.toLowerCase(),
					}}
					className="text-xs text-accent-blue-text hover:underline"
					data-testid="cascade-trigger-task"
				>
					{triggeredIdentifier}
				</Link>
			) : (
				<span className="text-xs text-text-muted">{triggeredIdentifier || 'a blocker'}</span>
			);
		return (
			<div className="flex items-baseline gap-2 leading-[26px]" data-testid="status-change-cascade">
				<span className="text-xs text-text-muted">Auto-unblocked — {triggerNode} closed</span>
				{timestamp}
			</div>
		);
	}
	const actorName = comment.author_name ?? 'Board';
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-muted">
				{actorName} changed status from <em className="italic">{formatTaskStatus(from)}</em> to{' '}
				<em className="italic">{formatTaskStatus(to)}</em>
			</span>
			{timestamp}
		</div>
	);
}

function RunFailedBody({
	content,
	teamId,
	timestamp,
}: {
	content: SystemRunFailedContent;
	teamId?: string;
	timestamp: React.ReactNode;
}) {
	const agentSlug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
	const status = typeof content.status === 'string' ? content.status : 'failed';
	const error =
		typeof content.error === 'string' && content.error.length > 0 ? content.error : null;
	const statusLabel = status === 'timed_out' ? 'timed out' : 'failed';
	const agentNode =
		agentSlug && teamId ? (
			<Link
				to="/teams/$teamId/agents/$agentId"
				params={{ teamId, agentId: agentSlug }}
				className="text-xs text-accent-blue-text hover:underline"
				data-testid="run-failed-agent"
			>
				@{agentSlug}
			</Link>
		) : (
			<span className="text-xs text-text-muted">agent</span>
		);
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid="run-failed-comment"
		>
			<span className="text-xs text-text-muted">
				Run for {agentNode} {statusLabel}
				{error ? <span className="text-text-subtle">: {error}</span> : null}. Waking agent to retry.
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
			className="text-xs text-accent-blue-text hover:underline"
			data-testid="repo-designated-link"
		>
			{identifier}
		</a>
	) : (
		<span className="text-xs text-text-muted">{identifier}</span>
	);
	return (
		<div className="flex items-baseline gap-2 leading-[26px]" data-testid="repo-designated-comment">
			<span className="text-xs text-text-muted">
				Repository {repoNode} set as the designated repo.
			</span>
			{timestamp}
		</div>
	);
}

function TaskLinkSystemBody({
	comment,
	content,
	teamId,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemTaskLinkContent;
	teamId: string;
}) {
	const sourceIdentifier = content.source_identifier ?? '';
	const sourceProjectSlug = content.source_project_slug ?? '';
	const actorName = content.actor_name ?? comment.author_name ?? 'Board';
	const actorKind = content.actor_kind ?? null;
	const actorSlug = content.actor_slug ?? null;

	const linkClass = 'text-xs text-accent-blue-text hover:underline';
	const textClass = 'text-xs text-text-muted';

	const sourceNode =
		sourceIdentifier && sourceProjectSlug ? (
			<Link
				to="/teams/$teamId/projects/$projectId/tasks/$taskId"
				params={{
					teamId,
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

	const actorNode =
		actorKind === 'agent' && actorSlug ? (
			<Link
				to="/teams/$teamId/agents/$agentId"
				params={{ teamId, agentId: actorSlug }}
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
			Linked from {sourceNode} by {actorNode}
		</span>
	);
}

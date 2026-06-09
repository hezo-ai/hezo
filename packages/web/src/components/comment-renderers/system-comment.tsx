import { formatTaskStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Loader2, RotateCw } from 'lucide-react';
import { useRetryFailedRun } from '../../hooks/use-retry-failed-run';
import { repoWebUrl } from '../../lib/github';
import type {
	SystemContent,
	SystemRepoDesignatedContent,
	SystemRunFailedContent,
	SystemStatusChangeContent,
	SystemTaskLinkContent,
} from '../comment-content';
import { Tooltip } from '../ui/tooltip';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'system'>;
	projectId?: string;
	taskId?: string;
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

export function SystemComment({ comment, projectId, taskId }: Props) {
	const content: SystemContent | null =
		comment.content && typeof comment.content === 'object' ? comment.content : null;
	const timestamp = (
		<span className="text-[11px] text-text-subtle">
			{new Date(comment.created_at).toLocaleString()}
		</span>
	);

	if (content && isTaskLink(content) && projectId) {
		return (
			<div className="flex items-baseline gap-2 leading-[26px]">
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
		return (
			<RunFailedBody
				content={content}
				projectId={projectId}
				taskId={taskId}
				timestamp={timestamp}
			/>
		);
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
	projectId,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemStatusChangeContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
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
	const actorName = comment.author_name ?? 'Admin';
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
	projectId,
	taskId,
	timestamp,
}: {
	content: SystemRunFailedContent;
	projectId?: string;
	taskId?: string;
	timestamp: React.ReactNode;
}) {
	const agentSlug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
	const status = typeof content.status === 'string' ? content.status : 'failed';
	const error =
		typeof content.error === 'string' && content.error.length > 0 ? content.error : null;
	const runId = typeof content.run_id === 'string' ? content.run_id : null;
	const statusLabel = status === 'timed_out' ? 'timed out' : 'failed';
	const agentNode =
		agentSlug && projectId ? (
			<Link
				to="/projects/$projectId/agents/$agentId"
				params={{ projectId, agentId: agentSlug }}
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
			<span className="text-xs text-text-muted inline-flex items-baseline gap-1.5 flex-wrap">
				<span>
					Run for {agentNode} {statusLabel}
					{error ? <span className="text-text-subtle">: {error}</span> : null}.
				</span>
				{projectId && taskId && runId ? (
					<RetryRunButton projectId={projectId} taskId={taskId} runId={runId} />
				) : null}
			</span>
			{timestamp}
		</div>
	);
}

function RetryRunButton({
	projectId,
	taskId,
	runId,
}: {
	projectId: string;
	taskId: string;
	runId: string;
}) {
	const retry = useRetryFailedRun({ projectId, taskId });
	return (
		<Tooltip content="Retry this run">
			<button
				type="button"
				onClick={() => retry.mutate(runId)}
				disabled={retry.isPending}
				aria-label="Retry failed run"
				data-testid="retry-failed-run"
				className="inline-flex items-center gap-1 self-baseline rounded-radius-md border border-border-default px-1.5 py-0.5 text-[11px] font-medium text-text-muted hover:bg-bg-subtle hover:text-text disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				{retry.isPending ? (
					<Loader2 className="w-3 h-3 animate-spin" />
				) : (
					<RotateCw className="w-3 h-3" />
				)}
				Retry
			</button>
		</Tooltip>
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
	projectId,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemTaskLinkContent;
	projectId: string;
}) {
	const sourceIdentifier = content.source_identifier ?? '';
	const sourceProjectSlug = content.source_project_slug ?? '';
	const actorName = content.actor_name ?? comment.author_name ?? 'Admin';
	const actorKind = content.actor_kind ?? null;
	const actorSlug = content.actor_slug ?? null;

	const linkClass = 'text-xs text-accent-blue-text hover:underline';
	const textClass = 'text-xs text-text-muted';

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
			Linked from {sourceNode} by {actorNode}
		</span>
	);
}

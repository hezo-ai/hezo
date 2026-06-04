import { Link } from '@tanstack/react-router';
import { DoorOpen } from 'lucide-react';
import { useState } from 'react';
import { formatElapsed } from '../../hooks/use-elapsed-duration';
import {
	getRunWaitingMessage,
	isActiveRunStatus,
	useHeartbeatRun,
} from '../../hooks/use-heartbeat-runs';
import { useRunLogs } from '../../hooks/use-run-logs';
import { LazyMount } from '../lazy-mount';
import { LogViewer } from '../log-viewer';
import { TerminateRunButton } from '../terminate-run-button';
import { Tooltip } from '../ui/tooltip';
import type { CommentDataOf } from './comment-data';
import { runStatusDotClass, runStatusLabel } from './helpers';

interface Props {
	comment: CommentDataOf<'run'>;
	teamId?: string;
	inline?: boolean;
}

export function RunComment({ comment, teamId, inline }: Props) {
	const runId = comment.content?.run_id ?? '';
	const agentId = comment.content?.agent_id ?? '';
	const agentTitle = comment.content?.agent_title ?? 'Agent';

	if (!teamId || !runId || !agentId) {
		return <p className="text-xs text-text-subtle italic">Run reference missing.</p>;
	}

	return (
		<div className="flex flex-col gap-1.5" data-testid="run-comment">
			<LazyMount minHeight={210} testId="run-comment-lazy">
				<RunCommentBody
					teamId={teamId}
					runId={runId}
					agentId={agentId}
					agentTitle={agentTitle}
					createdAt={comment.created_at}
					inline={inline}
				/>
			</LazyMount>
		</div>
	);
}

function RunCommentBody({
	teamId,
	runId,
	agentId,
	agentTitle,
	createdAt,
	inline,
}: {
	teamId: string;
	runId: string;
	agentId: string;
	agentTitle: string;
	createdAt: string;
	inline?: boolean;
}) {
	const runQuery = useHeartbeatRun(teamId, agentId, runId);
	const run = runQuery.data;
	const status = run?.status ?? 'queued';
	const isActive = isActiveRunStatus(status);
	const { lines } = useRunLogs(run?.project_id, runId, run?.log_text, isActive);
	const createdTasks = run?.created_tasks ?? [];
	const createdDocs = run?.created_docs ?? [];
	const createdSkills = run?.created_skills ?? [];
	const proposedSkills = run?.proposed_skills ?? [];
	const completed = run != null && !isActive;
	const durationMs =
		run?.started_at && run.finished_at
			? Math.max(0, new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
			: null;
	const [expanded, setExpanded] = useState(false);
	const logRegionId = `run-comment-log-${runId}`;

	// Single non-wrapping row: the agent title and status block keep their width,
	// the timestamp truncates first under pressure, and the status block clips
	// last — so the header (and its expand chevron) stay on one horizontal line at
	// any width, including once the log opens and a scrollbar narrows the row.
	const summaryRow = (
		<span className="flex flex-1 items-center gap-x-2 min-w-0 overflow-hidden">
			<span className="text-xs text-text-muted shrink-0 whitespace-nowrap">{agentTitle} run</span>
			{completed && (
				<span
					className="inline-flex items-center gap-1.5 text-xs text-text-subtle shrink-0 whitespace-nowrap"
					data-testid="run-comment-summary"
				>
					<span
						aria-hidden="true"
						className={`inline-block w-2 h-2 rounded-full ${runStatusDotClass(status)}`}
					/>
					<span>{runStatusLabel(status)}</span>
					<span aria-hidden="true">·</span>
					<span data-testid="run-comment-line-count">
						{lines.length} {lines.length === 1 ? 'line' : 'lines'}
					</span>
					{durationMs != null && (
						<>
							<span aria-hidden="true">·</span>
							<span data-testid="run-comment-duration">{formatElapsed(durationMs)}</span>
						</>
					)}
				</span>
			)}
			<span className="text-[11px] text-text-subtle truncate min-w-0">
				{new Date(createdAt).toLocaleString()}
			</span>
		</span>
	);

	return (
		<>
			{inline &&
				(completed ? (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
						aria-controls={logRegionId}
						data-testid="run-comment-header"
						className="flex items-center gap-2 min-h-[26px] min-w-0 text-left -mx-1 px-1 rounded-radius-md hover:bg-bg-muted cursor-pointer"
					>
						{summaryRow}
						<svg
							aria-hidden="true"
							className={`w-3 h-3 shrink-0 text-text-subtle transition-transform ${expanded ? 'rotate-90' : ''}`}
							viewBox="0 0 16 16"
							fill="currentColor"
						>
							<path d="M6 3l5 5-5 5V3z" />
						</svg>
					</button>
				) : (
					<div className="flex items-center min-h-[26px] min-w-0" data-testid="run-comment-header">
						{summaryRow}
					</div>
				))}
			{(!completed || expanded) && (
				<div id={logRegionId}>
					<LogViewer
						lines={lines}
						compact
						formattable
						teamId={teamId}
						projectSlug={run?.project_slug ?? undefined}
						heightClassName="h-[180px]"
						testId="run-comment-log"
						liveLabel={
							<span className="flex items-center gap-1.5">
								<span
									className={`inline-block w-2 h-2 rounded-full ${runStatusDotClass(status)}`}
								/>
								<span>
									{agentTitle} — {runStatusLabel(status)}
								</span>
							</span>
						}
						emptyState={getRunWaitingMessage(status)}
						headerActionLeading={
							<TerminateRunButton
								teamId={teamId}
								agentId={agentId}
								runId={runId}
								status={status}
								taskId={run?.task_id ?? null}
							/>
						}
						headerAction={
							<Tooltip content="View full run">
								<Link
									to="/teams/$teamId/agents/$agentId/executions/$runId"
									params={{ teamId, agentId, runId }}
									aria-label="View full run"
									className="inline-flex items-center justify-center h-6 px-2 text-xs text-text-muted hover:text-text hover:bg-bg-muted rounded-radius-md transition-colors"
								>
									<DoorOpen className="w-3 h-3" />
								</Link>
							</Tooltip>
						}
					/>
				</div>
			)}
			{createdTasks.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-tasks">
					{createdTasks.map((task) => (
						<Link
							key={task.id}
							to="/teams/$teamId/projects/$projectId/tasks/$taskId"
							params={{
								teamId,
								projectId: task.project_slug,
								taskId: task.identifier.toLowerCase(),
							}}
							className="text-xs text-accent-blue-text hover:underline self-start"
						>
							Created ticket {task.identifier} — {task.title}
						</Link>
					))}
				</div>
			)}
			{createdDocs.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-docs">
					{createdDocs.map((doc) => (
						<Link
							key={doc.filename}
							to="/teams/$teamId/projects/$projectId/documents"
							params={{ teamId, projectId: doc.project_slug }}
							search={{ file: doc.filename }}
							className="text-xs text-accent-blue-text hover:underline self-start"
						>
							Updated {doc.filename}
						</Link>
					))}
				</div>
			)}
			{createdSkills.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-skills">
					{createdSkills.map((skill) => (
						<Link
							key={skill.slug}
							to="/teams/$teamId/skills"
							params={{ teamId }}
							search={{ slug: skill.slug }}
							className="text-xs text-accent-blue-text hover:underline self-start"
						>
							{skill.created ? 'Added' : 'Updated'} skill {skill.name}
						</Link>
					))}
				</div>
			)}
			{proposedSkills.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-proposed-skills">
					{proposedSkills.map((skill) => (
						<Link
							key={skill.slug}
							to="/teams/$teamId/inbox"
							params={{ teamId }}
							className="text-xs text-accent-blue-text hover:underline self-start"
						>
							Proposed skill {skill.name}
						</Link>
					))}
				</div>
			)}
		</>
	);
}

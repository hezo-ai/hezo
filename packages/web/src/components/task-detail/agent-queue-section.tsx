import { Loader2, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCancelQueuedWakeup } from '../../hooks/use-cancel-queued-wakeup';
import type { ExecutionLock } from '../../hooks/use-execution-locks';
import type { QueuedDispatchState, QueuedWakeup } from '../../hooks/use-queued-wakeups';
import { useRunQueuedWakeup } from '../../hooks/use-run-queued-wakeup';
import { useTerminateRun } from '../../hooks/use-terminate-run';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';

// Run comments carry a JSON object payload, but the shared Comment type declares
// `content: string`; accept `unknown` here and narrow at read time (same shape
// the old RunningAgentsLine used).
type RunCommentRef = { id: string; content_type: string; content: unknown };

interface AgentQueueSectionProps {
	teamId: string;
	taskId: string;
	locks: ExecutionLock[];
	comments: RunCommentRef[];
	wakeups: QueuedWakeup[];
	dispatch: QueuedDispatchState | undefined;
}

/**
 * Unified "Agent Queue" panel for the task sidebar: the agent(s) currently
 * running on the task on top (loader + terminate), with the queued agents
 * underneath. Hidden only when the task is fully idle (no running and no
 * queued agents).
 */
export function AgentQueueSection({
	teamId,
	taskId,
	locks,
	comments,
	wakeups,
	dispatch,
}: AgentQueueSectionProps) {
	if (locks.length === 0 && wakeups.length === 0) return null;

	// Map each running agent to its current run via the run comment, which is the
	// only place the heartbeat run id surfaces to the client. Iterate in order so
	// the most recent run comment per agent wins.
	const runByMemberId = new Map<string, { runId: string; commentId: string }>();
	for (const c of comments) {
		if (c.content_type !== 'run') continue;
		const content =
			c.content && typeof c.content === 'object'
				? (c.content as { agent_id?: string; run_id?: string })
				: null;
		if (content?.agent_id && content.run_id) {
			runByMemberId.set(content.agent_id, { runId: content.run_id, commentId: c.id });
		}
	}

	const orderedLocks = [...locks].sort((a, b) => a.locked_at.localeCompare(b.locked_at));

	return (
		<div data-testid="agent-queue-section">
			<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
				Agent Queue
			</span>
			<div className="flex flex-col gap-1">
				{orderedLocks.map((lock) => (
					<RunningAgentRow
						key={lock.id}
						teamId={teamId}
						taskId={taskId}
						lock={lock}
						run={runByMemberId.get(lock.member_id)}
					/>
				))}
				{wakeups.length > 0 && dispatch && (
					<div data-testid="queued-agents-list" className="flex flex-col gap-1">
						{wakeups.map((w) => (
							<QueuedAgentRow
								key={w.id}
								teamId={teamId}
								taskId={taskId}
								wakeup={w}
								dispatch={dispatch}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function RunningAgentRow({
	teamId,
	taskId,
	lock,
	run,
}: {
	teamId: string;
	taskId: string;
	lock: ExecutionLock;
	run: { runId: string; commentId: string } | undefined;
}) {
	const [open, setOpen] = useState(false);
	// Reuse the run page's terminate flow verbatim. runId is empty when no run
	// comment has landed yet — the terminate control isn't rendered in that case,
	// so the mutation can never fire with it.
	const terminateMutation = useTerminateRun({
		teamId,
		agentId: lock.member_id,
		runId: run?.runId ?? '',
		taskId,
	});

	return (
		<div
			data-testid={`running-agent-${lock.member_id}`}
			className="flex items-center justify-between gap-2 text-[13px] text-text"
		>
			{run ? (
				<a
					href={`#comment-${run.commentId}`}
					onClick={(e) => {
						// Drive scroll via the hash so the task page's hashchange handler can
						// ask Virtuoso to mount and scroll to the row even when it isn't
						// currently in the DOM (scrollIntoView alone fails for off-screen
						// virtualized rows).
						e.preventDefault();
						const next = `#comment-${run.commentId}`;
						if (window.location.hash === next) {
							window.dispatchEvent(new HashChangeEvent('hashchange'));
						} else {
							window.history.pushState(null, '', next);
							window.dispatchEvent(new HashChangeEvent('hashchange'));
						}
					}}
					className="text-accent-blue-text font-medium hover:underline truncate min-w-0"
				>
					{lock.member_name}
				</a>
			) : (
				<span className="text-accent-blue-text font-medium truncate min-w-0">
					{lock.member_name}
				</span>
			)}
			<div className="flex items-center gap-1 shrink-0">
				<Loader2 className="w-3.5 h-3.5 animate-spin text-accent-blue" aria-label="Running" />
				{run && (
					<Tooltip content="Terminate run">
						<button
							type="button"
							onClick={() => setOpen(true)}
							aria-label="Terminate run"
							data-testid={`terminate-running-agent-${lock.member_id}`}
							disabled={terminateMutation.isPending}
							className="inline-flex items-center justify-center h-6 w-6 text-accent-red hover:bg-accent-red/10 rounded-radius-md transition-colors"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</Tooltip>
				)}
			</div>
			{run && (
				<ConfirmDialog
					open={open}
					onOpenChange={setOpen}
					title="Terminate this run?"
					description="The agent will be aborted immediately. Any in-progress work in this run will be lost."
					confirmLabel="Terminate"
					cancelLabel="Cancel"
					variant="danger"
					loading={terminateMutation.isPending}
					onConfirm={async () => {
						await terminateMutation.mutateAsync();
					}}
				/>
			)}
		</div>
	);
}

/**
 * Human-readable reason the run-now action is unavailable, or null when it can
 * run. Mirrors the gating order of `JobManager.dispatchWakeupNow` on the server.
 */
function runNowBlockReason(wakeup: QueuedWakeup, dispatch: QueuedDispatchState): string | null {
	if (dispatch.task_busy) return 'This ticket already has a run in progress';
	if (dispatch.project_at_capacity) return 'Project is at its concurrent-run limit';
	if (wakeup.agent_busy) return 'This agent is currently running on another task in this project';
	if (wakeup.run_now_blocked === 'blocked_by_dependency') return 'Blocked by an open dependency';
	return null;
}

function QueuedAgentRow({
	teamId,
	taskId,
	wakeup,
	dispatch,
}: {
	teamId: string;
	taskId: string;
	wakeup: QueuedWakeup;
	dispatch: QueuedDispatchState;
}) {
	const [open, setOpen] = useState(false);
	const cancelMutation = useCancelQueuedWakeup({ teamId, taskId });
	const runMutation = useRunQueuedWakeup({ teamId, taskId });
	const blockReason = runNowBlockReason(wakeup, dispatch);

	return (
		<div
			data-testid={`queued-agent-${wakeup.id}`}
			className="flex items-center justify-between gap-2 text-[13px] text-text"
		>
			<span className="truncate min-w-0">{wakeup.member_name}</span>
			<div className="flex items-center gap-1 shrink-0">
				{blockReason ? (
					// aria-disabled (not the native `disabled` attribute) keeps the button
					// emitting pointer events so the Radix tooltip still shows the reason.
					<Tooltip content={blockReason}>
						<button
							type="button"
							aria-disabled="true"
							aria-label={`Run now unavailable: ${blockReason}`}
							data-testid={`run-queued-wakeup-${wakeup.id}`}
							onClick={(e) => e.preventDefault()}
							className="inline-flex items-center justify-center h-6 w-6 text-accent-green opacity-40 cursor-not-allowed rounded-radius-md"
						>
							<Play className="w-3.5 h-3.5" />
						</button>
					</Tooltip>
				) : (
					<Tooltip content="Run now">
						<button
							type="button"
							onClick={() => runMutation.mutate(wakeup.id)}
							aria-label="Run queued agent now"
							data-testid={`run-queued-wakeup-${wakeup.id}`}
							disabled={runMutation.isPending}
							className="inline-flex items-center justify-center h-6 w-6 text-accent-green hover:bg-accent-green/10 rounded-radius-md transition-colors"
						>
							{runMutation.isPending ? (
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
							) : (
								<Play className="w-3.5 h-3.5" />
							)}
						</button>
					</Tooltip>
				)}
				<Tooltip content="Cancel queued run">
					<button
						type="button"
						onClick={() => setOpen(true)}
						aria-label="Cancel queued agent"
						data-testid={`cancel-queued-wakeup-${wakeup.id}`}
						disabled={cancelMutation.isPending}
						className="inline-flex items-center justify-center h-6 w-6 text-accent-red hover:bg-accent-red/10 rounded-radius-md transition-colors"
					>
						<Trash2 className="w-3.5 h-3.5" />
					</button>
				</Tooltip>
			</div>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Cancel queued agent?"
				description={`${wakeup.member_name} will be removed from the queue and won't run on this task.`}
				confirmLabel="Cancel run"
				cancelLabel="Keep queued"
				variant="danger"
				loading={cancelMutation.isPending}
				onConfirm={async () => {
					await cancelMutation.mutateAsync(wakeup.id);
				}}
			/>
		</div>
	);
}

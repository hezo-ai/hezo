import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowDown, ArrowUp, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMe } from '../hooks/use-me';
import {
	type CloneState,
	CONTAINER_AT_CAPACITY,
	type GitWorktree,
	type ResetAction,
	useRepoGitState,
	useResetRepo,
	useStartRepoContainer,
} from '../hooks/use-repo-git-state';
import { toast } from '../hooks/use-toast';
import { ApiError } from '../lib/api';
import { type MessageKey, useI18n } from '../lib/i18n';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Tooltip } from './ui/tooltip';

interface RepoGitStatePanelProps {
	projectId: string;
	repoId: string;
	repoName: string;
}

const RESET_COPY: Record<
	ResetAction,
	{ label: MessageKey; title: MessageKey; description: MessageKey; confirm: MessageKey }
> = {
	discard_local: {
		label: 'repoGitState.reset.discardLocal.label',
		title: 'repoGitState.reset.discardLocal.title',
		description: 'repoGitState.reset.discardLocal.description',
		confirm: 'repoGitState.reset.discardLocal.confirm',
	},
	prune_worktrees: {
		label: 'repoGitState.reset.pruneWorktrees.label',
		title: 'repoGitState.reset.pruneWorktrees.title',
		description: 'repoGitState.reset.pruneWorktrees.description',
		confirm: 'repoGitState.reset.pruneWorktrees.confirm',
	},
	reclone: {
		label: 'repoGitState.reset.reclone.label',
		title: 'repoGitState.reset.reclone.title',
		description: 'repoGitState.reset.reclone.description',
		confirm: 'repoGitState.reset.reclone.confirm',
	},
};

/** How often to re-ask for a container while the instance is at capacity. */
const CAPACITY_RETRY_MS = 5_000;
/** How often to re-read git state while a container the panel asked for comes up. */
const STARTING_WATCH_MS = 10_000;
/**
 * How long to keep either of those going before handing the panel back.
 *
 * Matches the agent runner's own capacity park. It bounds the *watching*, not the
 * start: a provision the server has begun runs to completion regardless, so the
 * copy at the end of it says to look again rather than claiming a failure.
 */
const START_DEADLINE_MS = 3 * 60_000;

type StartPhase =
	| { kind: 'idle' }
	| { kind: 'starting' }
	| { kind: 'waitingForCapacity' }
	| { kind: 'failed'; message: string };

/**
 * Superuser-only live git state for one repository: the clone's branch / HEAD /
 * dirty / ahead-behind, its active task worktrees, and the recovery actions
 * (discard local changes, prune worktrees, re-clone). Rendered when a repo row is
 * expanded; the state query runs lazily on mount.
 *
 * Git runs inside the project container, so there is nothing to show without one.
 * Expanding the row never starts one - that read stays passive. **Refresh does**:
 * it asks the server for a container, waits out the instance memory budget when
 * the instance is at capacity, and reads the state once one is up. The panel used
 * to print "container is stopped" with a link to a page that has no start control,
 * which told an operator something they could not act on.
 */
export function RepoGitStatePanel({ projectId, repoId, repoName }: RepoGitStatePanelProps) {
	const { t, plural } = useI18n();
	const [phase, setPhase] = useState<StartPhase>({ kind: 'idle' });
	const { data, isLoading, isError, refetch, isFetching } = useRepoGitState(
		projectId,
		repoId,
		true,
		phase.kind === 'starting' ? STARTING_WATCH_MS : undefined,
	);
	const startContainer = useStartRepoContainer(projectId, repoId);
	const resetRepo = useResetRepo(projectId, repoId);
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const [dialog, setDialog] = useState<ResetAction | null>(null);

	const running = data?.container_running === true;
	// One timer drives both waits: the capacity retry and the deadline that ends
	// the watch. Only ever one of them is pending, so they share the slot.
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const deadlineRef = useRef(0);
	const clearTimer = useCallback(() => {
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);
	useEffect(() => clearTimer, [clearTimer]);

	// The container came up - stop watching. Guarded so a settled panel does not
	// re-render itself on every poll of a query that is already answering.
	useEffect(() => {
		if (!running) return;
		clearTimer();
		setPhase((p) => (p.kind === 'idle' ? p : { kind: 'idle' }));
	}, [running, clearTimer]);

	const askForContainer = useCallback(async () => {
		clearTimer();
		try {
			const res = await startContainer.mutateAsync();
			if (res.container_running) {
				setPhase({ kind: 'idle' });
				await refetch();
				return;
			}
			// Under way. The git-state query polls for the result from here; this
			// timer only decides when to stop watching for it.
			setPhase({ kind: 'starting' });
			timerRef.current = setTimeout(
				() => setPhase({ kind: 'failed', message: t('repoGitState.startSlow') }),
				Math.max(0, deadlineRef.current - Date.now()),
			);
		} catch (e) {
			if (!(e instanceof ApiError) || e.code !== CONTAINER_AT_CAPACITY) {
				setPhase({
					kind: 'failed',
					message: e instanceof Error ? e.message : t('repoGitState.startFailed'),
				});
				return;
			}
			if (Date.now() >= deadlineRef.current) {
				setPhase({ kind: 'failed', message: t('repoGitState.capacityTimedOut') });
				return;
			}
			setPhase({ kind: 'waitingForCapacity' });
			timerRef.current = setTimeout(() => void askForContainer(), CAPACITY_RETRY_MS);
		}
	}, [startContainer, refetch, t, clearTimer]);

	const onRefresh = () => {
		if (running) {
			void refetch();
			return;
		}
		deadlineRef.current = Date.now() + START_DEADLINE_MS;
		void askForContainer();
	};

	const runReset = async (action: ResetAction) => {
		try {
			await resetRepo.mutateAsync(action);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t('repoGitState.reset.failed'));
		}
	};

	const busy =
		isFetching ||
		startContainer.isPending ||
		phase.kind === 'starting' ||
		phase.kind === 'waitingForCapacity';

	const refreshButton = (
		<Button
			variant="ghost"
			size="sm"
			onClick={onRefresh}
			disabled={busy}
			data-testid={`repo-git-refresh-${repoName}`}
		>
			{busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
			{t('repoGitState.refresh')}
		</Button>
	);

	return (
		<div
			className="mt-2 flex flex-col gap-3 border-t border-border-subtle pt-2"
			data-testid={`repo-git-state-${repoName}`}
		>
			<div className="flex items-center justify-between">
				<span className="text-xs font-medium text-text-2">{t('repoGitState.title')}</span>
				{running ? (
					refreshButton
				) : (
					<Tooltip content={t('repoGitState.refreshHint')}>{refreshButton}</Tooltip>
				)}
			</div>

			{isLoading ? (
				<div className="flex items-center gap-2 text-xs text-text-2">
					<Loader2 className="size-3.5 animate-spin" /> {t('repoGitState.loading')}
				</div>
			) : isError ? (
				<p className="text-xs text-danger-soft-fg">{t('repoGitState.loadError')}</p>
			) : data?.container_running === true ? (
				<>
					<CloneSummary clone={data.clone} />
					<Worktrees projectId={projectId} worktrees={data.worktrees} />
					{isSuperuser &&
						(() => {
							const runInProgressReason =
								data.active_runs > 0
									? plural('repoGitState.reset.blockedByRuns', data.active_runs)
									: undefined;
							return (
								<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
									<ResetActionButton
										action="discard_local"
										repoName={repoName}
										disabled={
											resetRepo.isPending ||
											data.active_runs > 0 ||
											!data.clone.cloned ||
											!data.clone.defaultBranch
										}
										disabledReason={
											runInProgressReason ??
											(!data.clone.cloned
												? t('repoGitState.notCloned')
												: !data.clone.defaultBranch
													? t('repoGitState.reset.noDefaultBranch')
													: undefined)
										}
										onClick={() => setDialog('discard_local')}
									/>
									<ResetActionButton
										action="prune_worktrees"
										repoName={repoName}
										disabled={resetRepo.isPending || data.active_runs > 0}
										disabledReason={runInProgressReason}
										onClick={() => setDialog('prune_worktrees')}
									/>
									<ResetActionButton
										action="reclone"
										repoName={repoName}
										disabled={resetRepo.isPending || data.active_runs > 0}
										disabledReason={runInProgressReason}
										onClick={() => setDialog('reclone')}
									/>
								</div>
							);
						})()}
				</>
			) : (
				<StartState phase={phase} repoName={repoName} onRetry={onRefresh} />
			)}

			{dialog && (
				<ConfirmDialog
					open={true}
					onOpenChange={(o) => {
						if (!o) setDialog(null);
					}}
					title={t(RESET_COPY[dialog].title)}
					description={t(RESET_COPY[dialog].description)}
					confirmLabel={t(RESET_COPY[dialog].confirm)}
					variant="danger"
					loading={resetRepo.isPending}
					onConfirm={async () => {
						await runReset(dialog);
					}}
				/>
			)}
		</div>
	);
}

/**
 * What the panel shows with no container: nothing at all until Refresh is pressed,
 * then the wait it is in. Idle renders empty on purpose - the button beside the
 * heading is the whole affordance, and a line explaining that there is no
 * container is the redundancy this panel is rid of.
 */
function StartState({
	phase,
	repoName,
	onRetry,
}: {
	phase: StartPhase;
	repoName: string;
	onRetry: () => void;
}) {
	const { t } = useI18n();
	if (phase.kind === 'idle') return null;

	if (phase.kind === 'failed') {
		return (
			<div
				className="flex flex-wrap items-center gap-2 text-xs text-danger-soft-fg"
				data-testid={`repo-git-start-failed-${repoName}`}
			>
				<AlertTriangle className="size-3.5 shrink-0" />
				<span>{phase.message}</span>
				<Button variant="secondary" size="sm" onClick={onRetry}>
					{t('repoGitState.retry')}
				</Button>
			</div>
		);
	}

	const waiting = phase.kind === 'waitingForCapacity';
	const line = (
		<div
			className="flex items-center gap-2 text-xs text-text-2"
			data-testid={
				waiting ? `repo-git-waiting-capacity-${repoName}` : `repo-git-starting-${repoName}`
			}
		>
			<Loader2 className="size-3.5 animate-spin" />
			{t(waiting ? 'repoGitState.waitingForCapacity' : 'repoGitState.starting')}
		</div>
	);
	if (!waiting) return line;
	return <Tooltip content={t('repoGitState.waitingForCapacityHelp')}>{line}</Tooltip>;
}

function CloneSummary({ clone }: { clone: CloneState }) {
	const { t } = useI18n();
	if (!clone.cloned) {
		return <p className="text-xs text-text-3">{t('repoGitState.notCloned')}</p>;
	}
	const showDivergence = (clone.ahead ?? 0) > 0 || (clone.behind ?? 0) > 0;
	return (
		<div
			className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
			data-testid="repo-clone-summary"
		>
			<span className="text-text-3">{t('repoGitState.clone')}</span>
			<Badge color="neutral" mono>
				<GitBranch className="size-3" />
				{clone.headBranch ?? clone.defaultBranch ?? t('repoGitState.detached')}
			</Badge>
			{clone.head === null ? (
				<Badge color="warning">{t('repoGitState.noCommits')}</Badge>
			) : (
				<>
					<span className="font-mono text-text-2">{clone.head.slice(0, 7)}</span>
					{clone.dirty ? (
						<Badge color="warning">
							<AlertTriangle className="size-3" /> {t('repoGitState.uncommitted')}
						</Badge>
					) : (
						<Badge color="success">{t('repoGitState.clean')}</Badge>
					)}
					{showDivergence && (
						<Tooltip content={t('repoGitState.divergenceHint')}>
							<span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-text-2">
								<span className="inline-flex items-center gap-0.5">
									<ArrowUp className="size-3" />
									{clone.ahead ?? 0}
								</span>
								<span className="inline-flex items-center gap-0.5">
									<ArrowDown className="size-3" />
									{clone.behind ?? 0}
								</span>
							</span>
						</Tooltip>
					)}
				</>
			)}
		</div>
	);
}

function Worktrees({ projectId, worktrees }: { projectId: string; worktrees: GitWorktree[] }) {
	const { t } = useI18n();
	if (worktrees.length === 0) {
		return <p className="text-xs text-text-3">{t('repoGitState.noWorktrees')}</p>;
	}
	return (
		<div className="flex flex-col gap-1" data-testid="repo-worktrees">
			<span className="text-xs text-text-3">
				{t('repoGitState.worktrees', { count: worktrees.length })}
			</span>
			{worktrees.map((w) => (
				<div key={w.taskIdentifier} className="flex flex-wrap items-center gap-2 text-xs">
					<Link
						to="/projects/$projectId/tasks/$taskId"
						params={{ projectId, taskId: w.taskIdentifier.toLowerCase() }}
						className="font-mono text-info-soft-fg hover:underline"
					>
						{w.taskIdentifier}
					</Link>
					{w.branch && <span className="font-mono text-text-3">{w.branch}</span>}
					<Badge color={w.dirty ? 'warning' : 'success'}>
						{t(w.dirty ? 'repoGitState.worktreeDirty' : 'repoGitState.worktreeClean')}
					</Badge>
					{w.task && <span className="max-w-[12rem] truncate text-text-2">{w.task.title}</span>}
				</div>
			))}
		</div>
	);
}

function ResetActionButton({
	action,
	repoName,
	disabled,
	disabledReason,
	onClick,
}: {
	action: ResetAction;
	repoName: string;
	disabled: boolean;
	disabledReason?: string;
	onClick: () => void;
}) {
	const { t } = useI18n();
	const button = (
		<Button
			variant="secondary"
			size="sm"
			disabled={disabled}
			onClick={onClick}
			data-testid={`repo-reset-${action}-${repoName}`}
		>
			{t(RESET_COPY[action].label)}
		</Button>
	);
	if (disabled && disabledReason) {
		return <Tooltip content={disabledReason}>{button}</Tooltip>;
	}
	return button;
}

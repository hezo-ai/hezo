import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowDown, ArrowUp, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../hooks/use-me';
import {
	type CloneState,
	type GitWorktree,
	type ResetAction,
	useRepoGitState,
	useResetRepo,
} from '../hooks/use-repo-git-state';
import { toast } from '../hooks/use-toast';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Tooltip } from './ui/tooltip';

interface RepoGitStatePanelProps {
	projectId: string;
	repoId: string;
	repoName: string;
}

const RESET_DIALOGS: Record<
	ResetAction,
	{ title: string; description: string; confirmLabel: string }
> = {
	discard_local: {
		title: 'Discard local changes?',
		description:
			'Discards all uncommitted and untracked changes in the repository clone and resets its default branch to origin. Committed work already pushed to GitHub is unaffected.',
		confirmLabel: 'Discard changes',
	},
	prune_worktrees: {
		title: 'Prune stale worktrees?',
		description:
			'Removes leftover per-task worktrees from crashed or interrupted runs and prunes worktree references. Committed work on their branches is preserved.',
		confirmLabel: 'Prune worktrees',
	},
	reclone: {
		title: 'Re-clone this repository?',
		description:
			'Deletes the on-disk clone entirely and re-clones it fresh from GitHub. All local-only state is discarded. Use this only to recover from deep corruption.',
		confirmLabel: 'Re-clone',
	},
};

/**
 * Superuser-only live git state for one repository: the clone's branch / HEAD /
 * dirty / ahead-behind, its active task worktrees, and the recovery actions
 * (discard local changes, prune worktrees, re-clone). Rendered when a repo row is
 * expanded; the state query runs lazily on mount.
 */
export function RepoGitStatePanel({ projectId, repoId, repoName }: RepoGitStatePanelProps) {
	const { data, isLoading, isError, refetch, isFetching } = useRepoGitState(
		projectId,
		repoId,
		true,
	);
	const resetRepo = useResetRepo(projectId, repoId);
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const [dialog, setDialog] = useState<ResetAction | null>(null);

	const runReset = async (action: ResetAction) => {
		try {
			await resetRepo.mutateAsync(action);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Reset failed');
		}
	};

	return (
		<div
			className="mt-2 flex flex-col gap-3 border-t border-border-subtle pt-2"
			data-testid={`repo-git-state-${repoName}`}
		>
			<div className="flex items-center justify-between">
				<span className="text-xs font-medium text-text-2">Git state</span>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => refetch()}
					disabled={isFetching}
					data-testid={`repo-git-refresh-${repoName}`}
				>
					{isFetching ? (
						<Loader2 className="size-3 animate-spin" />
					) : (
						<RefreshCw className="size-3" />
					)}
					Refresh
				</Button>
			</div>

			{isLoading ? (
				<div className="flex items-center gap-2 text-xs text-text-2">
					<Loader2 className="size-3.5 animate-spin" /> Loading git state…
				</div>
			) : isError ? (
				<p className="text-xs text-danger-soft-fg">Failed to load git state.</p>
			) : data?.container_running === false ? (
				<div
					className="rounded-md border border-border bg-surface-2 p-3 text-xs text-text-2"
					data-testid={`repo-git-container-stopped-${repoName}`}
				>
					Container is stopped —{' '}
					<Link
						to="/projects/$projectId/container"
						params={{ projectId }}
						className="text-info-soft-fg hover:underline"
					>
						start it
					</Link>{' '}
					to inspect git state.
				</div>
			) : data?.container_running === true ? (
				<>
					<CloneSummary clone={data.clone} />
					<Worktrees projectId={projectId} worktrees={data.worktrees} />
					{isSuperuser && (
						<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
							<ResetActionButton
								action="discard_local"
								label="Discard local changes"
								repoName={repoName}
								disabled={resetRepo.isPending || !data.clone.cloned || !data.clone.defaultBranch}
								disabledReason={
									!data.clone.cloned
										? 'Repository is not cloned yet'
										: !data.clone.defaultBranch
											? 'No default branch to reset to (empty repository)'
											: undefined
								}
								onClick={() => setDialog('discard_local')}
							/>
							<ResetActionButton
								action="prune_worktrees"
								label="Prune worktrees"
								repoName={repoName}
								disabled={resetRepo.isPending}
								onClick={() => setDialog('prune_worktrees')}
							/>
							<ResetActionButton
								action="reclone"
								label="Re-clone"
								repoName={repoName}
								disabled={resetRepo.isPending}
								onClick={() => setDialog('reclone')}
							/>
						</div>
					)}
				</>
			) : null}

			{dialog && (
				<ConfirmDialog
					open={true}
					onOpenChange={(o) => {
						if (!o) setDialog(null);
					}}
					title={RESET_DIALOGS[dialog].title}
					description={RESET_DIALOGS[dialog].description}
					confirmLabel={RESET_DIALOGS[dialog].confirmLabel}
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

function CloneSummary({ clone }: { clone: CloneState }) {
	if (!clone.cloned) {
		return <p className="text-xs text-text-3">Repository is not cloned yet.</p>;
	}
	const showDivergence = (clone.ahead ?? 0) > 0 || (clone.behind ?? 0) > 0;
	return (
		<div
			className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
			data-testid="repo-clone-summary"
		>
			<span className="text-text-3">Clone</span>
			<Badge color="neutral" mono>
				<GitBranch className="size-3" />
				{clone.headBranch ?? clone.defaultBranch ?? 'detached'}
			</Badge>
			{clone.head === null ? (
				<Badge color="warning">No commits yet</Badge>
			) : (
				<>
					<span className="font-mono text-text-2">{clone.head.slice(0, 7)}</span>
					{clone.dirty ? (
						<Badge color="warning">
							<AlertTriangle className="size-3" /> Uncommitted changes
						</Badge>
					) : (
						<Badge color="success">Clean</Badge>
					)}
					{showDivergence && (
						<Tooltip content="Relative to the last fetch from origin">
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
	if (worktrees.length === 0) {
		return <p className="text-xs text-text-3">No active task worktrees.</p>;
	}
	return (
		<div className="flex flex-col gap-1" data-testid="repo-worktrees">
			<span className="text-xs text-text-3">Worktrees ({worktrees.length})</span>
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
					<Badge color={w.dirty ? 'warning' : 'success'}>{w.dirty ? 'dirty' : 'clean'}</Badge>
					{w.task && <span className="max-w-[12rem] truncate text-text-2">{w.task.title}</span>}
				</div>
			))}
		</div>
	);
}

function ResetActionButton({
	action,
	label,
	repoName,
	disabled,
	disabledReason,
	onClick,
}: {
	action: ResetAction;
	label: string;
	repoName: string;
	disabled: boolean;
	disabledReason?: string;
	onClick: () => void;
}) {
	const button = (
		<Button
			variant="secondary"
			size="sm"
			disabled={disabled}
			onClick={onClick}
			data-testid={`repo-reset-${action}-${repoName}`}
		>
			{label}
		</Button>
	);
	if (disabled && disabledReason) {
		return <Tooltip content={disabledReason}>{button}</Tooltip>;
	}
	return button;
}

import { DEFAULT_LOG_COMPACTION_RETENTION_DAYS } from '@hezo/shared';
import { Database, Loader2, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type DatabaseInfo, useDatabaseInfo } from '../hooks/use-database-info';
import { useMe } from '../hooks/use-me';
import {
	type RunLogUsage,
	useCompactRunLogs,
	useRunLogUsage,
} from '../hooks/use-run-log-compaction';
import { usePruneSuperseded, useSupersededData } from '../hooks/use-superseded-data';
import { toast } from '../hooks/use-toast';
import { formatBytes } from './asset-icon';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';

const RETENTION_OPTIONS = [7, 30, 90] as const;

/**
 * Database storage card, rendered side-by-side with the asset-storage card
 * inside {@link StorageSection} (now on the dedicated Storage settings subpage).
 * Superuser-only, matching the endpoints' gates. The connection string arrives
 * pre-redacted from the server — this component never sees the raw URL.
 *
 * Layout, top to bottom: the backend details, a live size readout, then the
 * compaction control (all about the *current* database) — then a full-width
 * divider, and below it the pre-migration snapshot prune (the *old* databases,
 * shipped in #813). The size readout's `database_bytes` is embedded-only; the
 * snapshot footer shows only when there is something to reclaim.
 */
export function DatabaseSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useDatabaseInfo(isSuperuser);
	const isEmbedded = info?.backend === 'embedded';

	const [retentionDays, setRetentionDays] = useState<number>(DEFAULT_LOG_COMPACTION_RETENTION_DAYS);
	const { data: usage } = useRunLogUsage(retentionDays, isSuperuser && info !== undefined);

	const { data: superseded } = useSupersededData(isSuperuser && isEmbedded);
	const prune = usePruneSuperseded();
	const [pruneConfirmOpen, setPruneConfirmOpen] = useState(false);

	if (!isSuperuser) return null;

	const hasSnapshots = isEmbedded && superseded !== undefined && superseded.count > 0;

	return (
		<div className="border border-border rounded-md p-3 bg-surface" data-testid="settings-database">
			{info === undefined ? null : <DatabaseDetails info={info} />}

			{usage && (
				<>
					<RunLogUsageStats usage={usage} />
					<CompactionControl
						usage={usage}
						retentionDays={retentionDays}
						onRetentionChange={setRetentionDays}
					/>
				</>
			)}

			{hasSnapshots && (
				<>
					{/* Full-width divider: the current database above, the old ones below. */}
					<div className="-mx-3 my-3 border-t border-border-strong" aria-hidden="true" />
					<div
						className="flex items-center justify-between gap-3"
						data-testid="settings-database-superseded"
					>
						<div className="min-w-0">
							<div className="text-[12px] font-medium">Previous versions</div>
							<div
								className="text-[12px] text-text-3 mt-0.5"
								data-testid="settings-database-superseded-size"
							>
								{superseded.count} {superseded.count === 1 ? 'snapshot' : 'snapshots'} ·{' '}
								{formatBytes(superseded.bytes)} on disk
							</div>
						</div>
						<button
							type="button"
							onClick={() => setPruneConfirmOpen(true)}
							data-testid="settings-database-prune"
							className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-danger transition-colors hover:border-danger-soft hover:bg-danger-soft hover:text-danger-soft-fg"
						>
							<Trash2 className="h-3 w-3" />
							Prune…
						</button>
					</div>
					<ConfirmDialog
						open={pruneConfirmOpen}
						onOpenChange={setPruneConfirmOpen}
						title="Prune old database versions?"
						variant="danger"
						confirmLabel={`Prune ${formatBytes(superseded.bytes)}`}
						description={
							<>
								Hezo keeps a copy of your previous database after each upgrade so it can roll back a
								failed one. You have{' '}
								<strong className="font-medium text-text-1">
									{superseded.count} previous {superseded.count === 1 ? 'version' : 'versions'}
								</strong>{' '}
								using{' '}
								<strong className="font-medium text-text-1">{formatBytes(superseded.bytes)}</strong>{' '}
								of disk. This can’t be undone - your current database is untouched, but you won’t be
								able to roll back to an earlier version.
							</>
						}
						onConfirm={async () => {
							try {
								await prune.mutateAsync();
							} catch (e) {
								toast.error(
									e instanceof Error ? e.message : 'Failed to prune old database versions',
								);
							}
						}}
					/>
				</>
			)}
		</div>
	);
}

function DatabaseDetails({ info }: { info: DatabaseInfo }) {
	const isExternal = info.backend === 'external';
	// Icon stands in for the storage type — a managed Postgres server vs. the
	// bundled embedded database.
	const Icon = isExternal ? Server : Database;
	return (
		<div className="flex items-start gap-3">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2">
				<Icon className="h-4 w-4" />
			</div>
			<div className="min-w-0">
				<div className="flex items-baseline gap-1.5 flex-wrap">
					<h3 className="text-[13px] font-medium">Database</h3>
					<span className="text-[10px] text-text-3" aria-hidden="true">
						&bull;
					</span>
					<span className="text-[13px] text-text-2" data-testid="settings-database-backend">
						{isExternal ? 'External Postgres' : 'Embedded (PGlite)'}
					</span>
				</div>
				<p
					className="text-[12px] text-text-2 mt-1 font-mono break-all"
					data-testid="settings-database-display"
				>
					{info.display}
				</p>
				{info.server_version && (
					<p className="text-[12px] text-text-3 mt-1" data-testid="settings-database-version">
						PostgreSQL {info.server_version}
					</p>
				)}
			</div>
		</div>
	);
}

/** Live size readout: on-disk DB size (embedded) + total run-log size. */
function RunLogUsageStats({ usage }: { usage: RunLogUsage }) {
	return (
		<div
			className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-x-4 gap-y-2.5"
			data-testid="settings-run-log-usage"
		>
			{usage.database_bytes != null && (
				<div>
					<div className="text-[11px] text-text-3">Database size</div>
					<div className="text-[15px] font-medium tabular-nums" data-testid="settings-db-size">
						{formatBytes(usage.database_bytes)}
					</div>
				</div>
			)}
			<div>
				<div className="text-[11px] text-text-3">Run logs</div>
				<div className="text-[15px] font-medium tabular-nums" data-testid="settings-run-log-size">
					{formatBytes(usage.run_log_bytes)}{' '}
					<span className="text-[11px] font-normal text-text-3">
						· {usage.run_count.toLocaleString()} {usage.run_count === 1 ? 'run' : 'runs'}
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * The compaction control: pick a retention window, see what's reclaimable, and
 * start a background pass. While a pass runs the button is disabled and a
 * progress bar advances (driven by the polling usage query).
 */
function CompactionControl({
	usage,
	retentionDays,
	onRetentionChange,
}: {
	usage: RunLogUsage;
	retentionDays: number;
	onRetentionChange: (days: number) => void;
}) {
	const compact = useCompactRunLogs();
	const [confirmOpen, setConfirmOpen] = useState(false);

	const running = usage.compaction != null;
	const nothingToTrim = usage.compactable_run_count === 0;
	// The embedded backend can always reclaim dead-tuple bloat via VACUUM, even
	// when nothing is old enough to trim; external only benefits from trimming.
	const canReclaim = usage.backend === 'embedded';
	const disabled = running || compact.isPending || (nothingToTrim && !canReclaim);

	const percent = usage.compaction
		? Math.min(
				100,
				Math.round((usage.compaction.processed / Math.max(1, usage.compaction.total)) * 100),
			)
		: 0;

	return (
		<div className="mt-3 pt-3 border-t border-border" data-testid="settings-compaction">
			<h4 className="text-[12.5px] font-semibold">Compact old run logs</h4>
			<p className="text-[12px] text-text-2 mt-1 leading-relaxed">
				Trims the verbose output of old agent runs down to each run’s final summary. The command
				that launched each run is kept, and every trimmed log is clearly marked as compacted. Runs
				in the background, a batch at a time.
			</p>

			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				<label className="text-[12px] text-text-2" htmlFor="compaction-retention">
					Older than
				</label>
				<select
					id="compaction-retention"
					data-testid="settings-compact-retention"
					value={retentionDays}
					disabled={running}
					onChange={(e) => onRetentionChange(Number(e.target.value))}
					className="rounded-md border border-border bg-surface-2 px-2 py-1 text-[12.5px] text-text-1 disabled:opacity-50"
				>
					{RETENTION_OPTIONS.map((d) => (
						<option key={d} value={d}>
							{d} days
						</option>
					))}
				</select>
				<Button
					size="sm"
					data-testid="settings-compact-button"
					disabled={disabled}
					onClick={() => setConfirmOpen(true)}
				>
					{running && <Loader2 className="w-3 h-3 animate-spin" />}
					{running ? 'Compacting…' : 'Compact run logs'}
				</Button>
			</div>

			{running && usage.compaction ? (
				<div className="mt-3" data-testid="settings-compact-progress">
					<div className="flex justify-between text-[11.5px] text-text-2 mb-1.5 tabular-nums">
						<span>Compacting…</span>
						<span>
							{usage.compaction.processed.toLocaleString()} /{' '}
							{usage.compaction.total.toLocaleString()} runs ·{' '}
							{formatBytes(usage.compaction.bytes_reclaimed)} trimmed
						</span>
					</div>
					<div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
						<div
							className="h-full rounded-full bg-accent transition-[width] duration-300"
							style={{ width: `${percent}%` }}
						/>
					</div>
				</div>
			) : (
				<p className="mt-2 text-[12px] text-text-2" data-testid="settings-compact-reclaimable">
					{canReclaim ? (
						<>
							<span className="font-medium text-accent">
								≈ {formatBytes(usage.reclaimable_bytes)}
							</span>{' '}
							reclaimable ·{' '}
							{nothingToTrim ? (
								<>reclaims storage bloat (no runs older than {retentionDays} days to trim)</>
							) : (
								<>
									trims {usage.compactable_run_count.toLocaleString()}{' '}
									{usage.compactable_run_count === 1 ? 'run' : 'runs'} older than {retentionDays}{' '}
									days
								</>
							)}
						</>
					) : nothingToTrim ? (
						<>Nothing older than {retentionDays} days to compact.</>
					) : (
						<>
							Trims {usage.compactable_run_count.toLocaleString()}{' '}
							{usage.compactable_run_count === 1 ? 'run' : 'runs'} older than {retentionDays} days.
						</>
					)}
				</p>
			)}

			{!running && usage.last && (
				<p className="mt-2 text-[12px] text-success-soft-fg" data-testid="settings-compact-last">
					Last compaction: {usage.last.processed.toLocaleString()} runs ·{' '}
					{formatBytes(usage.last.bytes_reclaimed)} reclaimed.
				</p>
			)}

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Compact run logs older than ${retentionDays} days?`}
				confirmLabel="Compact run logs"
				description={
					<>
						This trims the full logs of agent runs older than{' '}
						<strong className="font-medium text-text-1">{retentionDays} days</strong> down to their
						final portion - the agent’s end-of-run summary and outcome. The full command that
						launched each run is kept, every trimmed log is clearly marked as compacted, and status,
						timing, tokens and cost are unchanged. Runs newer than the window are untouched. The
						detailed step-by-step output is permanently discarded and can’t be recovered.
						{usage.backend === 'embedded' && (
							<>
								{' '}
								It then rewrites the run-logs table to return the freed space - and accumulated
								storage bloat - to disk, which briefly locks that table.
							</>
						)}
					</>
				}
				onConfirm={async () => {
					try {
						await compact.mutateAsync(retentionDays);
					} catch (e) {
						toast.error(e instanceof Error ? e.message : 'Failed to start log compaction');
					}
				}}
			/>
		</div>
	);
}

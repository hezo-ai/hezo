import {
	DEFAULT_LOG_COMPACTION_RETENTION_DAYS,
	type FinishedRunLogPass,
	RunLogPassKind,
	RunLogPassPhase,
	RunLogRewriteFailureReason,
} from '@hezo/shared';
import { Database, Loader2, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type DatabaseInfo, useDatabaseInfo } from '../hooks/use-database-info';
import { useMe } from '../hooks/use-me';
import {
	type RunLogUsage,
	useCompactRunLogs,
	useReclaimRunLogSpace,
	useRunLogUsage,
} from '../hooks/use-run-log-compaction';
import { usePruneSuperseded, useSupersededData } from '../hooks/use-superseded-data';
import { toast } from '../hooks/use-toast';
import { type MessageKey, Trans, useI18n } from '../lib/i18n';
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
 * Layout, top to bottom: the backend details, a live size readout, the
 * compaction control and the control that returns free space to disk (all
 * about the *current* database) — then a full-width divider, and below it the
 * pre-migration snapshot prune (the *old* databases, shipped in #813). The size
 * readout's `database_bytes` is embedded-only; the snapshot footer shows only
 * when there is something to reclaim.
 */
export function DatabaseSection() {
	const { t, plural } = useI18n();
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
					<ReclaimControl usage={usage} />
					{usage.compaction === null && usage.last && <LastPass last={usage.last} />}
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
							<div className="text-[12px] font-medium">
								{t('settings.database.snapshots.title')}
							</div>
							<div
								className="text-[12px] text-text-3 mt-0.5"
								data-testid="settings-database-superseded-size"
							>
								{plural('settings.database.snapshots.size', superseded.count, {
									size: formatBytes(superseded.bytes),
								})}
							</div>
						</div>
						<button
							type="button"
							onClick={() => setPruneConfirmOpen(true)}
							data-testid="settings-database-prune"
							className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-danger transition-colors hover:border-danger-soft hover:bg-danger-soft hover:text-danger-soft-fg"
						>
							<Trash2 className="h-3 w-3" />
							{t('settings.database.snapshots.prune')}
						</button>
					</div>
					<ConfirmDialog
						open={pruneConfirmOpen}
						onOpenChange={setPruneConfirmOpen}
						title={t('settings.database.pruneConfirm.title')}
						variant="danger"
						confirmLabel={t('settings.database.pruneConfirm.confirm', {
							size: formatBytes(superseded.bytes),
						})}
						description={
							<Trans
								k="settings.database.pruneConfirm.body"
								vars={{
									versions: (
										<strong className="font-medium text-text-1">
											{plural('settings.database.pruneConfirm.versions', superseded.count)}
										</strong>
									),
									size: (
										<strong className="font-medium text-text-1">
											{formatBytes(superseded.bytes)}
										</strong>
									),
								}}
							/>
						}
						onConfirm={async () => {
							try {
								await prune.mutateAsync();
							} catch (e) {
								toast.error(e instanceof Error ? e.message : t('settings.database.pruneFailed'));
							}
						}}
					/>
				</>
			)}
		</div>
	);
}

function DatabaseDetails({ info }: { info: DatabaseInfo }) {
	const { t } = useI18n();
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
					<h3 className="text-[13px] font-medium">{t('settings.database.title')}</h3>
					<span className="text-[10px] text-text-3" aria-hidden="true">
						&bull;
					</span>
					<span className="text-[13px] text-text-2" data-testid="settings-database-backend">
						{isExternal
							? t('settings.database.backend.external')
							: t('settings.database.backend.embedded')}
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

/**
 * Live size readout: on-disk DB size (embedded) + total run-log size, and how
 * much of the run-log size is free space a rewrite would return. The estimate
 * is only computed when no pass is running.
 */
function RunLogUsageStats({ usage }: { usage: RunLogUsage }) {
	const { t, plural, formatNumber } = useI18n();
	return (
		<div
			className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-x-4 gap-y-2.5"
			data-testid="settings-run-log-usage"
		>
			{usage.database_bytes != null && (
				<div>
					<div className="text-[11px] text-text-3">{t('settings.database.size')}</div>
					<div className="text-[15px] font-medium tabular-nums" data-testid="settings-db-size">
						{formatBytes(usage.database_bytes)}
					</div>
				</div>
			)}
			<div>
				<div className="text-[11px] text-text-3">{t('settings.database.runLogs')}</div>
				<div className="text-[15px] font-medium tabular-nums" data-testid="settings-run-log-size">
					{formatBytes(usage.run_log_bytes)}{' '}
					<span className="text-[11px] font-normal text-text-3">
						·{' '}
						{plural('thread.group.runs', usage.run_count, {
							count: formatNumber(usage.run_count),
						})}
					</span>
				</div>
			</div>
			{usage.compaction === null && (
				<p className="col-span-2 text-[12px] text-text-2" data-testid="settings-run-log-free">
					{usage.free_bytes > 0
						? t('settings.database.free.some', { size: formatBytes(usage.free_bytes) })
						: t('settings.database.free.little')}
				</p>
			)}
		</div>
	);
}

/**
 * The compaction control: pick a retention window, see how many runs it would
 * trim, and start a background pass. While any pass runs the button is disabled;
 * during a compaction a progress bar advances (driven by the polling usage
 * query), and on the embedded backend it then shows the closing rewrite.
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
	const { t, plural, formatNumber } = useI18n();
	const compact = useCompactRunLogs();
	const [confirmOpen, setConfirmOpen] = useState(false);

	const active = usage.compaction;
	const compacting = active?.kind === RunLogPassKind.Compact ? active : null;
	const nothingToTrim = usage.compactable_run_count === 0;
	const disabled = active !== null || compact.isPending || nothingToTrim;

	const percent = compacting
		? Math.min(100, Math.round((compacting.processed / Math.max(1, compacting.total)) * 100))
		: 0;

	return (
		<div className="mt-3 pt-3 border-t border-border" data-testid="settings-compaction">
			<h4 className="text-[12.5px] font-semibold">{t('settings.database.compact.title')}</h4>
			<p className="text-[12px] text-text-2 mt-1 leading-relaxed">
				{t('settings.database.compact.description')}
			</p>

			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				<label className="text-[12px] text-text-2" htmlFor="compaction-retention">
					{t('settings.database.compact.olderThan')}
				</label>
				<select
					id="compaction-retention"
					data-testid="settings-compact-retention"
					value={retentionDays}
					disabled={active !== null}
					onChange={(e) => onRetentionChange(Number(e.target.value))}
					className="rounded-md border border-border bg-surface-2 px-2 py-1 text-[12.5px] text-text-1 disabled:opacity-50"
				>
					{RETENTION_OPTIONS.map((d) => (
						<option key={d} value={d}>
							{t('settings.database.compact.days', { days: d })}
						</option>
					))}
				</select>
				<Button
					size="sm"
					data-testid="settings-compact-button"
					disabled={disabled}
					onClick={() => setConfirmOpen(true)}
				>
					{compacting && <Loader2 className="w-3 h-3 animate-spin" />}
					{compacting
						? t('settings.database.compact.running')
						: t('settings.database.compactConfirm.confirm')}
				</Button>
			</div>

			{compacting?.phase === RunLogPassPhase.Trimming ? (
				<div className="mt-3" data-testid="settings-compact-progress">
					<div className="flex justify-between gap-2 text-[11.5px] text-text-2 mb-1.5 tabular-nums">
						<span>{t('settings.database.compact.running')}</span>
						<span>
							{t('settings.database.compact.progress', {
								processed: formatNumber(compacting.processed),
								total: formatNumber(compacting.total),
								size: formatBytes(compacting.trimmed_bytes),
							})}
						</span>
					</div>
					<div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
						<div
							className="h-full rounded-full bg-accent transition-[width] duration-300"
							style={{ width: `${percent}%` }}
						/>
					</div>
				</div>
			) : compacting ? (
				// The embedded backend's closing rewrite; the button still says "Compacting".
				<p
					className="mt-2 flex items-center gap-1.5 text-[12px] text-text-2"
					data-testid="settings-compact-rewriting"
				>
					<Loader2 className="w-3 h-3 animate-spin" />
					{t('settings.database.rewriting')}
				</p>
			) : (
				<p className="mt-2 text-[12px] text-text-2" data-testid="settings-compact-eligible">
					{nothingToTrim
						? t('settings.database.compact.none', { days: retentionDays })
						: plural('settings.database.compact.eligible', usage.compactable_run_count, {
								count: formatNumber(usage.compactable_run_count),
								days: retentionDays,
							})}
				</p>
			)}

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={t('settings.database.compactConfirm.title', { days: retentionDays })}
				confirmLabel={t('settings.database.compactConfirm.confirm')}
				description={
					<>
						<Trans
							k="settings.database.compactConfirm.body"
							vars={{
								days: <strong className="font-medium text-text-1">{retentionDays}</strong>,
							}}
						/>
						{usage.backend === 'embedded' && <> {t('settings.database.compactConfirm.embedded')}</>}
					</>
				}
				onConfirm={async () => {
					try {
						await compact.mutateAsync(retentionDays);
					} catch (e) {
						toast.error(
							e instanceof Error ? e.message : t('settings.database.compact.startFailed'),
						);
					}
				}}
			/>
		</div>
	);
}

/**
 * Rewrites the run-log tables so the free space inside them goes back to the
 * disk. Offered on both backends: an embedded compaction ends with the same
 * rewrite, but free space also builds up between compactions.
 */
function ReclaimControl({ usage }: { usage: RunLogUsage }) {
	const { t } = useI18n();
	const reclaim = useReclaimRunLogSpace();
	const [confirmOpen, setConfirmOpen] = useState(false);

	const active = usage.compaction;
	const reclaiming = active?.kind === RunLogPassKind.Reclaim;

	return (
		<div className="mt-3 pt-3 border-t border-border" data-testid="settings-reclaim">
			<h4 className="text-[12.5px] font-semibold">{t('settings.database.reclaim.title')}</h4>
			<p className="text-[12px] text-text-2 mt-1 leading-relaxed">
				{t('settings.database.reclaim.description')}
			</p>
			<div className="mt-2.5">
				<Button
					size="sm"
					data-testid="settings-reclaim-button"
					disabled={active !== null || reclaim.isPending}
					onClick={() => setConfirmOpen(true)}
				>
					{reclaiming && <Loader2 className="w-3 h-3 animate-spin" />}
					{reclaiming ? t('settings.database.rewriting') : t('settings.database.reclaim.action')}
				</Button>
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={t('settings.database.reclaimConfirm.title')}
				confirmLabel={t('settings.database.reclaim.action')}
				description={t('settings.database.reclaimConfirm.body')}
				onConfirm={async () => {
					try {
						await reclaim.mutateAsync();
					} catch (e) {
						toast.error(
							e instanceof Error ? e.message : t('settings.database.reclaim.startFailed'),
						);
					}
				}}
			/>
		</div>
	);
}

/** One sentence per rewrite failure, each naming the table it stopped at. */
const REWRITE_FAILURE_KEYS: Record<RunLogRewriteFailureReason, MessageKey> = {
	[RunLogRewriteFailureReason.Busy]: 'settings.database.rewriteFailure.busy',
	[RunLogRewriteFailureReason.NotOwner]: 'settings.database.rewriteFailure.notOwner',
	[RunLogRewriteFailureReason.Failed]: 'settings.database.rewriteFailure.failed',
};

/**
 * The most recent finished pass. The log text a compaction trimmed and the disk
 * a rewrite returned are separate figures: trimming alone never shrinks the
 * files, so only the second one is disk space.
 */
function LastPass({ last }: { last: FinishedRunLogPass }) {
	const { t, plural, formatNumber } = useI18n();
	const failure = last.rewrite_failure;
	// A rewrite stopped at its first table freed nothing worth stating.
	const freed =
		last.disk_bytes_freed !== null && (failure === null || last.disk_bytes_freed > 0)
			? formatBytes(last.disk_bytes_freed)
			: null;

	let summary: string | null = null;
	if (last.kind === RunLogPassKind.Reclaim) {
		summary = freed ? t('settings.database.last.reclaim', { freed }) : null;
	} else {
		const count = formatNumber(last.processed);
		const trimmed = last.trimmed_bytes === null ? null : formatBytes(last.trimmed_bytes);
		if (trimmed && freed) {
			summary = plural('settings.database.last.trimmedFreed', last.processed, {
				count,
				trimmed,
				freed,
			});
		} else if (trimmed) {
			summary = plural('settings.database.last.trimmed', last.processed, { count, trimmed });
		} else if (freed) {
			summary = plural('settings.database.last.freed', last.processed, { count, freed });
		} else {
			summary = plural('settings.database.last.runs', last.processed, { count });
		}
	}

	return (
		<div className="mt-2" data-testid="settings-run-log-last">
			{summary && <p className="text-[12px] text-success-soft-fg">{summary}</p>}
			{failure && (
				<p
					className="mt-1 text-[12px] text-danger-soft-fg"
					data-testid="settings-run-log-rewrite-failure"
				>
					{t(REWRITE_FAILURE_KEYS[failure.reason], {
						table: failure.table,
						message: failure.message ?? '',
					})}
				</p>
			)}
		</div>
	);
}

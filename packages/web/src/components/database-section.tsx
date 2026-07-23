import { Database, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type DatabaseInfo, useDatabaseInfo } from '../hooks/use-database-info';
import { useMe } from '../hooks/use-me';
import { usePruneSuperseded, useSupersededData } from '../hooks/use-superseded-data';
import { toast } from '../hooks/use-toast';
import { formatBytes } from './asset-icon';
import { ConfirmDialog } from './ui/confirm-dialog';

/**
 * Database storage card, rendered side-by-side with the asset-storage card
 * inside {@link StorageSection}. Superuser-only, matching the endpoint's gate.
 * The connection string arrives pre-redacted from the server — this component
 * never sees, stores, or reveals the raw URL.
 *
 * For the embedded backend it also surfaces the on-disk size of the retained
 * pre-migration snapshots (`pgdata.superseded.*`) with a control to prune them.
 * That footer is shown only when there is something to reclaim — hidden for
 * external Postgres (no snapshots) and when zero snapshots remain.
 */
export function DatabaseSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useDatabaseInfo(isSuperuser);
	const isEmbedded = info?.backend === 'embedded';
	const { data: superseded } = useSupersededData(isSuperuser && isEmbedded);
	const prune = usePruneSuperseded();
	const [confirmOpen, setConfirmOpen] = useState(false);

	if (!isSuperuser) return null;

	const hasSnapshots = isEmbedded && superseded !== undefined && superseded.count > 0;

	return (
		<div className="border border-border rounded-md p-3 bg-surface" data-testid="settings-database">
			{info === undefined ? null : <DatabaseDetails info={info} />}
			{hasSnapshots && (
				<div
					className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-3"
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
						onClick={() => setConfirmOpen(true)}
						data-testid="settings-database-prune"
						className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-danger transition-colors hover:border-danger-soft hover:bg-danger-soft hover:text-danger-soft-fg"
					>
						<Trash2 className="h-3 w-3" />
						Prune…
					</button>
				</div>
			)}
			{hasSnapshots && (
				<ConfirmDialog
					open={confirmOpen}
					onOpenChange={setConfirmOpen}
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
							of disk. This can’t be undone — your current database is untouched, but you won’t be
							able to roll back to an earlier version.
						</>
					}
					onConfirm={async () => {
						try {
							await prune.mutateAsync();
						} catch (e) {
							toast.error(e instanceof Error ? e.message : 'Failed to prune old database versions');
						}
					}}
				/>
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

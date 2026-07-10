import { Database, Server } from 'lucide-react';
import { type DatabaseInfo, useDatabaseInfo } from '../hooks/use-database-info';
import { useMe } from '../hooks/use-me';

/**
 * Database storage card, rendered side-by-side with the asset-storage card
 * inside {@link StorageSection}. Superuser-only, matching the endpoint's gate.
 * The connection string arrives pre-redacted from the server — this component
 * never sees, stores, or reveals the raw URL.
 */
export function DatabaseSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useDatabaseInfo(isSuperuser);

	if (!isSuperuser) return null;

	return (
		<div className="border border-border rounded-md p-3 bg-surface" data-testid="settings-database">
			{info === undefined ? null : <DatabaseDetails info={info} />}
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

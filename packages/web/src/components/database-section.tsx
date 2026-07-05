import { type DatabaseInfo, useDatabaseInfo } from '../hooks/use-database-info';
import { useMe } from '../hooks/use-me';

/**
 * Storage card on General settings (rendered just before the Version
 * section). Superuser-only, matching the endpoint's gate. The connection
 * string arrives pre-redacted from the server — this component never sees,
 * stores, or reveals the raw URL.
 */
export function DatabaseSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useDatabaseInfo(isSuperuser);

	if (!isSuperuser) return null;

	return (
		<section className="mt-8" data-testid="settings-database">
			<div className="mb-4">
				<h2 className="text-base font-medium">Database</h2>
				<p className="text-[13px] text-text-2 mt-1">Where this instance stores its data.</p>
			</div>
			<div className="border border-border rounded-md p-3 bg-surface">
				{info === undefined ? null : <DatabaseDetails info={info} />}
			</div>
		</section>
	);
}

function DatabaseDetails({ info }: { info: DatabaseInfo }) {
	return (
		<dl className="flex flex-col gap-3">
			<div>
				<dt className="text-[13px] font-medium">Storage</dt>
				<dd className="text-[13px] text-text-2 mt-0.5" data-testid="settings-database-backend">
					{info.backend === 'external' ? 'External Postgres' : 'Embedded (PGlite)'}
				</dd>
			</div>
			<div>
				<dt className="text-[13px] font-medium">
					{info.backend === 'external' ? 'Connection' : 'Location'}
				</dt>
				<dd
					className="text-[13px] text-text-2 mt-0.5 font-mono break-all"
					data-testid="settings-database-display"
				>
					{info.display}
				</dd>
			</div>
			{info.server_version && (
				<div>
					<dt className="text-[13px] font-medium">Server version</dt>
					<dd className="text-[13px] text-text-2 mt-0.5" data-testid="settings-database-version">
						PostgreSQL {info.server_version}
					</dd>
				</div>
			)}
		</dl>
	);
}

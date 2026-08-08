import { Boxes, Cloud } from 'lucide-react';
import { useMe } from '../hooks/use-me';
import { type SandboxBackendInfo, useSandboxBackendInfo } from '../hooks/use-sandbox-backend-info';
import { useI18n } from '../lib/i18n';
import { backendDisplayName } from '../lib/sandbox-backend';

/**
 * Sandbox-backend card, rendered alongside the database and asset-storage cards
 * inside {@link StorageSection}. Superuser-only, matching the endpoint's gate.
 *
 * Read-only: the backend is deployment configuration (`--sandbox-backend` and
 * its provider credential), chosen once at startup and never changed at
 * runtime, so this reports rather than edits. The provider endpoint arrives
 * pre-redacted from the server - this component never sees the API key.
 */
export function SandboxBackendSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useSandboxBackendInfo(isSuperuser);

	if (!isSuperuser) return null;

	return (
		<div
			className="border border-border rounded-md p-3 bg-surface"
			data-testid="settings-sandbox-backend"
		>
			{info === undefined ? null : <SandboxBackendDetails info={info} />}
		</div>
	);
}

function SandboxBackendDetails({ info }: { info: SandboxBackendInfo }) {
	const { t } = useI18n();
	const isManaged = info.backend !== 'docker';
	// Icon stands in for where containers run — a managed service vs. the local
	// daemon.
	const Icon = isManaged ? Cloud : Boxes;
	return (
		<div className="flex items-start gap-3">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2">
				<Icon className="h-4 w-4" />
			</div>
			<div className="min-w-0">
				<div className="flex items-baseline gap-1.5 flex-wrap">
					<h3 className="text-[13px] font-medium">{t('settings.sandboxBackend.title')}</h3>
					<span className="text-[10px] text-text-3" aria-hidden="true">
						&bull;
					</span>
					<span className="text-[13px] text-text-2" data-testid="settings-sandbox-backend-name">
						{/* Named from the shared table, not from `isManaged`: rendering the
						    literal "Daytona" for anything that is not Docker names the wrong
						    provider the moment there is a second one. */}
						{backendDisplayName(info.backend, t)}
					</span>
				</div>
				{isManaged && (
					<p
						className="text-[12px] text-text-2 mt-1 font-mono break-all"
						data-testid="settings-sandbox-backend-display"
					>
						{info.display}
					</p>
				)}
			</div>
		</div>
	);
}

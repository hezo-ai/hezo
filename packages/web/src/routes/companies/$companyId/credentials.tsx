import { createFileRoute } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { type Column, DataTable } from '../../../components/ui/data-table';
import { type CredentialUsage, useCredentials } from '../../../hooks/use-credentials';
import { useDeleteSecret } from '../../../hooks/use-secrets';

function formatRelative(iso: string | null): string {
	if (!iso) return 'never';
	const ms = Date.now() - new Date(iso).getTime();
	const min = 60 * 1000;
	const hr = 60 * min;
	const day = 24 * hr;
	if (ms < min) return 'just now';
	if (ms < hr) return `${Math.floor(ms / min)}m ago`;
	if (ms < day) return `${Math.floor(ms / hr)}h ago`;
	return `${Math.floor(ms / day)}d ago`;
}

function CredentialsPage() {
	const { companyId } = Route.useParams();
	const { data: rows = [] } = useCredentials(companyId);
	const deleteSecret = useDeleteSecret(companyId);

	const columns: Column<CredentialUsage>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (r) => (
				<span className="flex items-center gap-2">
					<span className="font-mono text-[13px]">{r.name}</span>
					<Badge color="neutral">{r.category}</Badge>
					{r.project_name && <span className="text-xs text-text-subtle">{r.project_name}</span>}
				</span>
			),
		},
		{
			key: 'hosts',
			header: 'Allowed hosts',
			hideOnMobile: true,
			render: (r) => {
				if (r.allow_all_hosts) return <Badge color="warning">all hosts</Badge>;
				if (!r.allowed_hosts.length) return <Badge color="danger">no hosts</Badge>;
				return (
					<span className="text-xs font-mono text-text-muted truncate">
						{r.allowed_hosts.join(', ')}
					</span>
				);
			},
		},
		{
			key: 'usage',
			header: 'Last used',
			render: (r) => (
				<span className="text-xs">
					<span title={r.last_used_at ?? ''}>{formatRelative(r.last_used_at)}</span>
					{r.last_host && <span className="text-text-subtle ml-2 font-mono">{r.last_host}</span>}
				</span>
			),
		},
		{
			key: 'count',
			header: 'Uses',
			hideOnMobile: true,
			render: (r) => <span className="text-xs">{r.use_count.toLocaleString()}</span>,
		},
		{
			key: 'actions',
			header: '',
			render: (r) => (
				<button
					type="button"
					onClick={() => {
						if (
							confirm(
								`Revoke secret "${r.name}"? Any in-flight runs that try to use it will get a 400 unknown_secret response.`,
							)
						) {
							deleteSecret.mutate(r.id);
						}
					}}
					className="text-text-subtle hover:text-accent-red"
					title="Revoke"
				>
					<Trash2 className="w-3.5 h-3.5" />
				</button>
			),
		},
	];

	return (
		<div>
			<div className="mb-4">
				<h2 className="text-base font-medium">Credentials</h2>
				<p className="text-[13px] text-text-muted mt-1">
					Every secret in the vault, with its allowed-hosts policy and the most recent egress proxy
					substitution from the audit log. Revoking a secret deletes the row — agents that reference
					the placeholder will get an unknown_secret 400 from the proxy on the next outbound call.
				</p>
			</div>
			{!rows.length ? (
				<p className="text-[13px] text-text-muted">
					No credentials stored. Agents request credentials via the request_credential MCP tool, or
					operators add them in company settings.
				</p>
			) : (
				<DataTable columns={columns} data={rows} rowKey={(row) => row.id} />
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/credentials')({
	component: CredentialsPage,
});

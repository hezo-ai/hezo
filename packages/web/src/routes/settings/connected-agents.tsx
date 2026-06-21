import { ConnectedAgentStatus } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Check, Loader2, Unplug, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { type Column, DataTable } from '../../components/ui/data-table';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Tooltip } from '../../components/ui/tooltip';
import {
	type ConnectedAgent,
	useApproveConnectedAgent,
	useConnectedAgents,
	useDisconnectConnectedAgent,
} from '../../hooks/use-connected-agents';
import { useMe } from '../../hooks/use-me';

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

function clientLabel(info: Record<string, unknown>): string | null {
	const name = typeof info.name === 'string' ? info.name : null;
	if (!name) return null;
	const version = typeof info.version === 'string' ? info.version : null;
	return version ? `${name} ${version}` : name;
}

function ConnectedAgentsPage() {
	const { data: me } = useMe();
	const { data: rows = [] } = useConnectedAgents();
	const approve = useApproveConnectedAgent();
	const disconnect = useDisconnectConnectedAgent();

	const pending = rows.filter((r) => r.status === ConnectedAgentStatus.Pending);
	const connected = rows.filter((r) => r.status === ConnectedAgentStatus.Approved);
	const busy = approve.isPending || disconnect.isPending;

	const clientColumn: Column<ConnectedAgent> = {
		key: 'client',
		header: 'Client',
		hideOnMobile: true,
		render: (r) => {
			const label = clientLabel(r.client_info);
			return label ? (
				<span className="text-xs font-mono text-text-2">{label}</span>
			) : (
				<span className="text-text-3">—</span>
			);
		},
	};

	const pendingColumns: Column<ConnectedAgent>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (r) => <span className="font-medium text-[13px]">{r.name}</span>,
		},
		clientColumn,
		{
			key: 'requested',
			header: 'Requested',
			render: (r) => <span className="text-xs text-text-2">{formatRelative(r.created_at)}</span>,
		},
		{
			key: 'actions',
			header: '',
			render: (r) => (
				<span className="flex items-center gap-2 justify-end">
					<Button size="sm" variant="approve" disabled={busy} onClick={() => approve.mutate(r.id)}>
						{approve.isPending ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<Check className="w-3 h-3" />
						)}
						Approve
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="text-danger"
						disabled={busy}
						onClick={() => {
							if (confirm(`Reject the connection request from "${r.name}"?`)) {
								disconnect.mutate(r.id);
							}
						}}
					>
						<X className="w-3 h-3" /> Reject
					</Button>
				</span>
			),
		},
	];

	const connectedColumns: Column<ConnectedAgent>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (r) => <span className="font-medium text-[13px]">{r.name}</span>,
		},
		clientColumn,
		{
			key: 'approved',
			header: 'Approved',
			hideOnMobile: true,
			render: (r) => <span className="text-xs text-text-2">{formatRelative(r.approved_at)}</span>,
		},
		{
			key: 'last_used',
			header: 'Last used',
			render: (r) => <span className="text-xs text-text-2">{formatRelative(r.last_used_at)}</span>,
		},
		{
			key: 'actions',
			header: '',
			render: (r) => (
				<span className="flex items-center gap-2 justify-end">
					<Tooltip content="Disconnect">
						<Button
							size="sm"
							variant="ghost"
							className="text-danger"
							disabled={busy}
							onClick={() => {
								if (
									confirm(
										`Disconnect "${r.name}"? Its token stops working immediately and it loses all access to this instance.`,
									)
								) {
									disconnect.mutate(r.id);
								}
							}}
						>
							<Unplug className="w-3.5 h-3.5" /> Disconnect
						</Button>
					</Tooltip>
				</span>
			),
		},
	];

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Connected agents are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-5">
					<div className="flex items-center gap-1.5">
						<h1 className="text-[22px] font-medium">Connected agents</h1>
						<InfoTooltip
							label="About connected agents"
							content="External AI agents (MCP clients) that have registered with this instance. Approve one to grant it full access; disconnect to revoke it."
							data-testid="connected-agents-info"
						/>
					</div>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						External AI agents (MCP clients like Claude) can register with this Hezo instance. A
						registration stays pending and grants no access until you approve it here. Once
						approved, a connected agent acts with{' '}
						<span className="font-medium">full admin access</span> — every project and team, just
						like you — so only approve agents you trust. Disconnect at any time to revoke a token
						immediately.
					</p>
				</div>

				<section className="mb-8">
					<h2 className="text-[13px] font-medium text-text-2 mb-2 flex items-center gap-2">
						Pending approval
						{pending.length > 0 && <Badge color="warning">{pending.length}</Badge>}
					</h2>
					{pending.length ? (
						<DataTable columns={pendingColumns} data={pending} rowKey={(r) => r.id} />
					) : (
						<p className="text-[13px] text-text-2">No pending requests.</p>
					)}
				</section>

				<section>
					<h2 className="text-[13px] font-medium text-text-2 mb-2">Connected</h2>
					{connected.length ? (
						<DataTable columns={connectedColumns} data={connected} rowKey={(r) => r.id} />
					) : (
						<p className="text-[13px] text-text-2">
							No connected agents yet. An agent appears here after it registers and you approve it.
						</p>
					)}
				</section>
			</>
		);

	return (
		<div className="max-w-[900px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">{content}</div>
	);
}

export const Route = createFileRoute('/settings/connected-agents')({
	component: ConnectedAgentsPage,
});

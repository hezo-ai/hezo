import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink, Github, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
	type DeviceFlowStart,
	type OAuthConnection,
	pollGitHubDeviceFlow,
	useDeleteOAuthConnection,
	useOAuthConnections,
	useStartGitHubDeviceFlow,
} from '../../../hooks/use-oauth-connections';

export const Route = createFileRoute('/companies/$companyId/connections')({
	component: ConnectionsPage,
});

function ConnectionsPage() {
	const { companyId } = Route.useParams();
	const { data: connections = [] } = useOAuthConnections(companyId);
	const startDeviceFlow = useStartGitHubDeviceFlow(companyId);
	const deleteConn = useDeleteOAuthConnection(companyId);
	const [deviceFlow, setDeviceFlow] = useState<DeviceFlowStart | null>(null);
	const [pollMessage, setPollMessage] = useState<string>('');
	const stopRef = useRef(false);

	useEffect(() => {
		if (!deviceFlow) return;
		stopRef.current = false;
		setPollMessage('Waiting for you to authorise on GitHub…');

		(async () => {
			while (!stopRef.current) {
				try {
					const result = await pollGitHubDeviceFlow(companyId, deviceFlow.flow_id);
					if (result.status === 'success') {
						setPollMessage(`Connected ${result.connection.provider_account_label}.`);
						setDeviceFlow(null);
						return;
					}
					await new Promise((r) =>
						setTimeout(r, Math.max(2000, (result.retry_after ?? deviceFlow.interval) * 1000)),
					);
				} catch (e) {
					setPollMessage((e as Error).message);
					setDeviceFlow(null);
					return;
				}
			}
		})();

		return () => {
			stopRef.current = true;
		};
	}, [deviceFlow, companyId]);

	const handleConnectGitHub = async () => {
		setPollMessage('');
		const flow = await startDeviceFlow.mutateAsync(undefined);
		setDeviceFlow(flow);
		try {
			window.open(flow.verification_uri, '_blank', 'noopener');
		} catch {
			// pop-up blocked — user can copy verification_uri from the prompt below
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-xl font-semibold">Connections</h2>
					<p className="text-sm text-text-subtle">
						OAuth tokens for GitHub repos and SaaS MCP servers. Tokens never leave the backend;
						agents substitute placeholders at request time.
					</p>
				</div>
				<Button onClick={handleConnectGitHub} disabled={startDeviceFlow.isPending || !!deviceFlow}>
					<Github className="size-4 mr-2" />
					Connect GitHub
				</Button>
			</div>

			{deviceFlow && (
				<div className="rounded-md border border-border-default bg-bg-subtle p-4 space-y-2">
					<p className="text-sm">
						Open{' '}
						<a
							href={deviceFlow.verification_uri}
							target="_blank"
							rel="noopener"
							className="underline inline-flex items-center gap-1"
						>
							{deviceFlow.verification_uri}
							<ExternalLink className="size-3" />
						</a>{' '}
						and enter this code:
					</p>
					<div className="font-mono text-2xl tracking-widest">{deviceFlow.user_code}</div>
					<p className="text-xs text-text-subtle">{pollMessage}</p>
					<Button variant="ghost" size="sm" onClick={() => setDeviceFlow(null)}>
						Cancel
					</Button>
				</div>
			)}
			{!deviceFlow && pollMessage && <p className="text-sm text-text-subtle">{pollMessage}</p>}

			<div className="rounded-md border border-border-default overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-bg-subtle text-left">
						<tr>
							<th className="px-3 py-2 font-medium">Provider</th>
							<th className="px-3 py-2 font-medium">Account</th>
							<th className="px-3 py-2 font-medium hidden sm:table-cell">Scopes</th>
							<th className="px-3 py-2 font-medium hidden md:table-cell">Connected</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody>
						{connections.length === 0 && (
							<tr>
								<td className="px-3 py-6 text-center text-text-subtle" colSpan={5}>
									No connections yet.
								</td>
							</tr>
						)}
						{connections.map((c: OAuthConnection) => (
							<tr key={c.id} className="border-t border-border-default">
								<td className="px-3 py-2 font-mono text-xs">
									<Badge color="neutral">{c.provider}</Badge>
								</td>
								<td className="px-3 py-2">{c.provider_account_label}</td>
								<td className="px-3 py-2 hidden sm:table-cell">
									<span className="text-xs font-mono text-text-muted">{c.scopes.join(' ')}</span>
								</td>
								<td className="px-3 py-2 hidden md:table-cell text-xs text-text-subtle">
									{new Date(c.created_at).toLocaleDateString()}
								</td>
								<td className="px-3 py-2 text-right">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											if (confirm(`Remove ${c.provider_account_label}?`)) {
												deleteConn.mutate(c.id);
											}
										}}
									>
										<Trash2 className="size-4" />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

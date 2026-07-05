import { getConnectorCapability } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { connectorStatus, useMcpConnection } from '../../hooks/use-mcp-connections';
import { useAuthStart } from '../../hooks/use-oauth-connections';
import { queryKeys } from '../../lib/query-keys';
import { ConnectorDeviceFlowDialog } from '../connector-device-flow-dialog';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'connect_required'>;
	projectId?: string;
}

export function ConnectRequiredComment({ comment, projectId }: Props) {
	const { connector_id, display_name, provider_id } = comment.content;
	const connectorQuery = useMcpConnection(projectId ?? '', connector_id);
	const authStart = useAuthStart(projectId ?? '');
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [deviceOpen, setDeviceOpen] = useState(false);

	// Refetch the connector immediately when the OAuth popup signals success,
	// without waiting for the WebSocket invalidation round-trip. The popup
	// posts {type: 'hezo-oauth-success'} via window.opener.postMessage from
	// the callback success page (see routes/oauth.ts:buildCallbackPage).
	useEffect(() => {
		if (!projectId) return;
		// The callback page lives on the server origin (e.g. localhost:3101)
		// while we're on the web origin (e.g. localhost:5174), so we can't
		// require e.origin === window.location.origin. We gate on message type
		// instead — the payload is just a type tag, not credentials.
		const onMessage = (e: MessageEvent) => {
			if (!e.data || typeof e.data !== 'object') return;
			if ((e.data as { type?: string }).type !== 'hezo-oauth-success') return;
			queryClient.invalidateQueries({
				queryKey: queryKeys.teams.mcpConnections(projectId),
			});
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [projectId, queryClient]);

	if (!projectId) {
		return <p className="text-xs text-text-3 italic">Connector setup unavailable in this view.</p>;
	}

	const connector = connectorQuery.data;
	const status = connector ? connectorStatus(connector) : 'pending';
	// Connectors are global resources (register_connector creates instance-level
	// rows), so the manage link goes to the global settings page.
	const focusedConnectorUrl = `/settings/connectors?focus=${connector_id}#${connector_id}`;

	// Providers whose AS can't do DCR (declared via `deviceAuth`) authorize
	// through the device flow; everything else uses the redirect popup.
	const capability = getConnectorCapability(connector?.name ?? provider_id ?? '');
	const usesDeviceFlow = !!capability?.deviceAuth;

	const openConnect = () => {
		setError(null);
		if (usesDeviceFlow) {
			setDeviceOpen(true);
			return;
		}
		authStart.mutate(connector_id, {
			onSuccess: ({ auth_url }) => {
				const popup = window.open(auth_url, 'hezo-connect', 'width=600,height=720');
				if (!popup) {
					setError('Pop-up blocked. Allow pop-ups for Hezo and try again.');
				}
			},
			onError: (e: unknown) => {
				setError(e instanceof Error ? e.message : 'Failed to start OAuth flow');
			},
		});
	};

	if (status === 'active') {
		return (
			<a
				href={focusedConnectorUrl}
				className="block no-underline"
				data-testid="connect-required-active"
				data-connector-id={connector_id}
			>
				<div className="flex items-start gap-2 p-2.5 rounded-lg border border-success bg-success-soft hover:bg-success-soft/80 transition-colors">
					<Check className="w-4 h-4 text-success-soft-fg shrink-0 mt-0.5" />
					<div className="flex-1">
						<p className="text-sm font-medium text-text-1">{display_name} connected</p>
						<p className="text-xs text-text-2 mt-0.5">
							Available to every agent run in this team. Click to manage in Connectors.
						</p>
					</div>
				</div>
			</a>
		);
	}

	const statusLabel =
		status === 'failed'
			? 'Last connect attempt failed — try again'
			: status === 'revoked'
				? 'Connector revoked — reconnect'
				: `Connect ${display_name} to authorize this agent's access`;

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-warning bg-warning-soft"
			data-testid="connect-required"
			data-connector-id={connector_id}
			data-status={status}
		>
			<div className="flex items-start gap-2">
				<Plug className="w-4 h-4 text-warning-soft-fg shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text-1">
						Connect required: <span className="font-semibold">{display_name}</span>
						{provider_id && (
							<code className="ml-2 text-xs text-text-2 px-1 py-0.5 rounded bg-surface-2">
								{provider_id}
							</code>
						)}
					</p>
					<p className="text-xs text-text-2 mt-0.5">{statusLabel}</p>
					{connector?.auth_error && (
						<p className="text-xs text-danger-soft-fg mt-1">{connector.auth_error}</p>
					)}
				</div>
			</div>
			{error && <p className="pl-6 text-xs text-danger-soft-fg">{error}</p>}
			{usesDeviceFlow && deviceOpen && (
				<ConnectorDeviceFlowDialog
					open={deviceOpen}
					onOpenChange={setDeviceOpen}
					projectId={projectId}
					connectorId={connector_id}
					providerLabel={display_name ?? capability?.displayName ?? provider_id ?? 'provider'}
					onSuccess={() =>
						queryClient.invalidateQueries({ queryKey: queryKeys.teams.mcpConnections(projectId) })
					}
				/>
			)}
			<div className="flex items-center gap-2 pl-6">
				<Button
					size="sm"
					onClick={openConnect}
					disabled={authStart.isPending}
					data-testid="connect-button"
				>
					{authStart.isPending ? 'Starting…' : 'Connect'}
				</Button>
				<a
					href={focusedConnectorUrl}
					className="text-xs text-text-2 hover:text-text-1 underline"
					data-testid="connect-required-link"
				>
					Open in Connectors
				</a>
			</div>
		</div>
	);
}

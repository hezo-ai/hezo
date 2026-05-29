import { Check, Plug } from 'lucide-react';
import { useState } from 'react';
import {
	connectorStatus,
	useConnectorAuthStart,
	useMcpConnection,
} from '../../hooks/use-mcp-connections';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'connect_required'>;
	teamId?: string;
}

export function ConnectRequiredComment({ comment, teamId }: Props) {
	const { connector_id, display_name, provider_id } = comment.content;
	const connectorQuery = useMcpConnection(teamId ?? '', connector_id);
	const authStart = useConnectorAuthStart(teamId ?? '');
	const [error, setError] = useState<string | null>(null);

	if (!teamId) {
		return (
			<p className="text-xs text-text-subtle italic">Connector setup unavailable in this view.</p>
		);
	}

	const connector = connectorQuery.data;
	const status = connector ? connectorStatus(connector) : 'pending';
	const connectorsUrl = `/teams/${teamId}/connectors`;
	const focusedConnectorUrl = `${connectorsUrl}?focus=${connector_id}#${connector_id}`;

	const openConnect = () => {
		setError(null);
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
				<div className="flex items-start gap-2 p-2.5 rounded-lg border border-accent-green bg-accent-green-bg hover:bg-accent-green-bg/80 transition-colors">
					<Check className="w-4 h-4 text-accent-green-text shrink-0 mt-0.5" />
					<div className="flex-1">
						<p className="text-sm font-medium text-text">{display_name} connected</p>
						<p className="text-xs text-text-muted mt-0.5">
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
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-accent-amber bg-accent-amber-bg"
			data-testid="connect-required"
			data-connector-id={connector_id}
			data-status={status}
		>
			<div className="flex items-start gap-2">
				<Plug className="w-4 h-4 text-accent-amber-text shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text">
						Connect required: <span className="font-semibold">{display_name}</span>
						{provider_id && (
							<code className="ml-2 text-xs text-text-muted px-1 py-0.5 rounded bg-bg-subtle">
								{provider_id}
							</code>
						)}
					</p>
					<p className="text-xs text-text-muted mt-0.5">{statusLabel}</p>
					{connector?.auth_error && (
						<p className="text-xs text-accent-red-text mt-1">{connector.auth_error}</p>
					)}
				</div>
			</div>
			{error && <p className="text-xs text-accent-red-text">{error}</p>}
			<div className="flex items-center gap-2">
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
					className="text-xs text-text-muted hover:text-text underline"
					data-testid="connect-required-link"
				>
					Open in Connectors
				</a>
			</div>
		</div>
	);
}

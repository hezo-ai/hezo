import { Check, Eye, Plug } from 'lucide-react';
import { connectorStatus, useConnector } from '../../hooks/use-connectors';
import { ConnectorCompletion } from '../connector-completion';
import { ConnectorProbeNotice } from '../connector-probe-notice';
import { Callout } from '../ui/callout';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'connect_required'>;
	projectId?: string;
}

export function ConnectRequiredComment({ comment, projectId }: Props) {
	const { connector_id, display_name, provider_id, requested_access } = comment.content;
	const connectorQuery = useConnector(projectId ?? '', connector_id);

	if (!projectId) {
		return <p className="text-xs text-text-3 italic">Connector setup unavailable in this view.</p>;
	}

	const connector = connectorQuery.data;
	const status = connector ? connectorStatus(connector) : 'pending';
	// This card renders inside a project task, so the manage link targets the
	// project's own Connectors page (which surfaces the same connector, project
	// + global) rather than the global settings surface.
	const focusedConnectorUrl = `/projects/${projectId}/connectors?focus=${connector_id}#${connector_id}`;

	if (status === 'active') {
		return (
			<a
				href={focusedConnectorUrl}
				className="block no-underline"
				data-testid="connect-required-active"
				data-connector-id={connector_id}
			>
				{/* `role="none"` throughout: a thread renders many of these at once, and
				    the thread is what a reader follows - one live region per card is noise. */}
				<Callout
					tone="success"
					role="none"
					className="border border-success hover:bg-success-soft/80 transition-colors"
					icon={<Check className="w-4 h-4" />}
				>
					<div>
						<p className="text-sm font-medium text-text-1">{display_name} connected</p>
						<p className="text-xs text-text-2 mt-0.5">
							Available to every agent run in this team. Click to manage in Connectors.
						</p>
					</div>
				</Callout>
			</a>
		);
	}

	const statusLabel =
		status === 'failed'
			? 'Last connect attempt failed - try again'
			: status === 'degraded'
				? // It connected once and the stored credential has since stopped being
					// accepted, so this card is a reconnect prompt rather than a first-time
					// setup step. Without this branch it fell into the green "connected"
					// case above and told the operator everything was fine.
					`${display_name} stopped working - reconnect to restore this agent's access`
				: status === 'revoked'
					? 'Connector revoked - reconnect'
					: `Connect ${display_name} to authorize this agent's access`;

	return (
		<Callout
			tone="warning"
			role="none"
			className="border border-warning"
			icon={<Plug className="w-4 h-4" />}
			data-testid="connect-required"
			data-connector-id={connector_id}
			data-status={status}
		>
			<div className="flex flex-col gap-2">
				<div>
					<p className="text-sm font-medium text-text-1">
						Connect required: <span className="font-semibold">{display_name}</span>
						{provider_id && (
							<code className="ml-2 text-xs text-text-2 px-1 py-0.5 rounded bg-surface-2">
								{provider_id}
							</code>
						)}
					</p>
					<p className="text-xs text-text-2 mt-0.5">{statusLabel}</p>
					{requested_access === 'read' && (
						// Say what the agent asked for *before* the human authorizes it,
						// so the narrower scope is visible at the moment of the decision
						// rather than something to discover on the Connectors page after.
						<p
							className="flex items-center gap-1.5 text-xs text-text-2 mt-1"
							data-testid="connect-required-read-only"
						>
							<Eye className="w-3.5 h-3.5 shrink-0 text-info" />
							<span>
								<span className="font-medium text-text-1">Read-only requested.</span> Write methods
								will be disabled once connected. You can change this in the connector's Settings.
							</span>
						</p>
					)}
					{connector?.auth_error && (
						<p className="text-xs text-danger-soft-fg mt-1">{connector.auth_error}</p>
					)}
					{connector && <ConnectorProbeNotice connector={connector} />}
				</div>
				<div className="flex flex-col gap-2">
					{connector && (
						<ConnectorCompletion connector={connector} projectId={projectId} variant="comment" />
					)}
					<a
						href={focusedConnectorUrl}
						className="text-xs text-text-2 hover:text-text-1 underline w-fit"
						data-testid="connect-required-link"
					>
						Open in Connectors
					</a>
				</div>
			</div>
		</Callout>
	);
}

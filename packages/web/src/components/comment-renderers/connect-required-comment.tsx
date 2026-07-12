import { Check, Plug } from 'lucide-react';
import { connectorStatus, useConnector } from '../../hooks/use-connectors';
import { ConnectorCompletion } from '../connector-completion';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'connect_required'>;
	projectId?: string;
}

export function ConnectRequiredComment({ comment, projectId }: Props) {
	const { connector_id, display_name, provider_id } = comment.content;
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
			<div className="flex flex-col gap-2 pl-6">
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
	);
}

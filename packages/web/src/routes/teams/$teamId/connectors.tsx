import { createFileRoute, Link } from '@tanstack/react-router';
import { Check, ExternalLink, Plug, Trash2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
	connectorStatus,
	type McpConnection,
	useConnectorAuthStart,
	useMcpConnections,
	useRevokeConnector,
} from '../../../hooks/use-mcp-connections';

interface ConnectorsSearch {
	focus?: string;
}

export const Route = createFileRoute('/teams/$teamId/connectors')({
	validateSearch: (search: Record<string, unknown>): ConnectorsSearch => ({
		focus: typeof search.focus === 'string' ? search.focus : undefined,
	}),
	component: ConnectorsPage,
});

function ConnectorsPage() {
	const { teamId } = Route.useParams();
	const { focus } = Route.useSearch();
	const { data: connectors = [] } = useMcpConnections(teamId);

	// Ref callback fires when the focused <li> mounts (which can happen after
	// the initial render once the connectors query resolves). Scrolls into view
	// then; no dependency-array gymnastics needed.
	const focusRef = useCallback((el: HTMLLIElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	return (
		<div className="space-y-6 p-4 sm:p-6 max-w-4xl mx-auto">
			<header>
				<h1 className="text-xl font-semibold flex items-center gap-2">
					<Plug className="size-5" />
					Connectors
				</h1>
				<p className="text-sm text-text-subtle mt-1">
					Third-party MCP servers and skill files agents use. Tokens are stored in the Hezo vault
					and substituted at egress; agents never see them.
				</p>
			</header>

			{connectors.length === 0 ? (
				<div className="rounded-md border border-border-default p-6 text-center text-text-subtle">
					No connectors yet. When an agent calls{' '}
					<code className="px-1 py-0.5 rounded bg-bg-subtle text-xs">register_connector</code>, a
					Connect button appears here and on the task that requested it.
				</div>
			) : (
				<ul className="space-y-3" data-testid="connectors-list">
					{connectors.map((connector) => (
						<ConnectorRow
							key={connector.id}
							connector={connector}
							teamId={teamId}
							focused={connector.id === focus}
							focusRef={connector.id === focus ? focusRef : undefined}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

interface ConnectorRowProps {
	connector: McpConnection;
	teamId: string;
	focused: boolean;
	focusRef?: (el: HTMLLIElement | null) => void;
}

function ConnectorRow({ connector, teamId, focused, focusRef }: ConnectorRowProps) {
	const status = connectorStatus(connector);
	const authStart = useConnectorAuthStart(teamId);
	const revoke = useRevokeConnector(teamId);
	const [error, setError] = useState<string | null>(null);

	const url =
		typeof connector.config === 'object' &&
		connector.config !== null &&
		typeof (connector.config as { url?: unknown }).url === 'string'
			? (connector.config as { url: string }).url
			: null;

	const openConnect = () => {
		setError(null);
		authStart.mutate(connector.id, {
			onSuccess: ({ auth_url }) => {
				const popup = window.open(auth_url, 'hezo-connect', 'width=600,height=720');
				if (!popup) {
					setError('Pop-up blocked. Allow pop-ups for Hezo and try again.');
				}
			},
			onError: (e: unknown) => {
				setError(e instanceof Error ? e.message : 'Failed to start OAuth');
			},
		});
	};

	const doRevoke = () => {
		setError(null);
		if (
			!window.confirm(
				`Revoke ${connector.display_name ?? connector.name}? Agents will lose access immediately.`,
			)
		)
			return;
		revoke.mutate(connector.id, {
			onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Failed to revoke'),
		});
	};

	return (
		<li
			ref={focusRef}
			id={connector.id}
			className={`rounded-lg border p-4 transition-colors ${
				focused ? 'border-accent-blue bg-accent-blue-bg' : 'border-border-default'
			}`}
			data-testid="connector-row"
			data-connector-id={connector.id}
			data-status={status}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<h2 className="text-base font-medium truncate">
							{connector.display_name ?? connector.name}
						</h2>
						<StatusBadge status={status} />
					</div>
					{url && <p className="text-xs text-text-muted mt-1 truncate font-mono">{url}</p>}
					{connector.skill_doc_id && (
						<p className="text-xs text-text-muted mt-1 flex items-center gap-1">
							<ExternalLink className="size-3" />
							Skill file imported
						</p>
					)}
					{connector.auth_error && status !== 'active' && (
						<p className="text-xs text-accent-red-text mt-2">{connector.auth_error}</p>
					)}
					{error && <p className="text-xs text-accent-red-text mt-2">{error}</p>}
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{status === 'active' ? (
						<Button
							size="sm"
							variant="outline"
							onClick={doRevoke}
							disabled={revoke.isPending}
							data-testid="connector-revoke"
						>
							<Trash2 className="size-3.5 mr-1" />
							{revoke.isPending ? 'Revoking…' : 'Disconnect'}
						</Button>
					) : (
						<Button
							size="sm"
							onClick={openConnect}
							disabled={authStart.isPending}
							data-testid="connector-connect"
						>
							{authStart.isPending ? 'Starting…' : status === 'failed' ? 'Retry' : 'Connect'}
						</Button>
					)}
				</div>
			</div>

			{connector.created_by_task_id && (
				<div className="mt-3 pt-3 border-t border-border-default text-xs text-text-muted">
					Requested by an agent.{' '}
					<Link
						to="/teams/$teamId/tasks/$taskId"
						params={{ teamId, taskId: connector.created_by_task_id }}
						className="underline hover:text-text"
					>
						View task
					</Link>
				</div>
			)}
		</li>
	);
}

function StatusBadge({ status }: { status: 'pending' | 'active' | 'failed' | 'revoked' }) {
	if (status === 'active') {
		return (
			<Badge className="bg-accent-green-bg text-accent-green-text border-accent-green">
				<Check className="size-3 mr-0.5 inline" />
				Connected
			</Badge>
		);
	}
	if (status === 'failed') {
		return (
			<Badge className="bg-accent-red-bg text-accent-red-text border-accent-red">
				<X className="size-3 mr-0.5 inline" />
				Failed
			</Badge>
		);
	}
	if (status === 'revoked') {
		return <Badge>Revoked</Badge>;
	}
	return (
		<Badge className="bg-accent-amber-bg text-accent-amber-text border-accent-amber">
			Pending connect
		</Badge>
	);
}

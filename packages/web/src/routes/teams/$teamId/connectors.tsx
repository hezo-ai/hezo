import { getConnectorCapability } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Check, ExternalLink, Github, Plug, Trash2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ConnectorDeviceFlowDialog } from '../../../components/connector-device-flow-dialog';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
	connectorStatus,
	type McpConnection,
	useMcpConnections,
	useRevokeConnector,
} from '../../../hooks/use-mcp-connections';
import {
	type OAuthConnection,
	useAuthStart,
	useDeleteOAuthConnection,
	useEnsureConnector,
	useOAuthConnections,
} from '../../../hooks/use-oauth-connections';

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
	const { data: oauthConnections = [] } = useOAuthConnections(teamId);

	// Ref callback fires when the focused <li> mounts (which can happen after
	// the initial render once the connectors query resolves). Scrolls into view
	// then; no dependency-array gymnastics needed.
	const focusRef = useCallback((el: HTMLLIElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	const githubConnection = oauthConnections.find((c) => c.provider === 'github') ?? null;
	const isEmpty = connectors.length === 0 && oauthConnections.length === 0;

	return (
		<div className="space-y-6 p-4 sm:p-6 max-w-4xl mx-auto">
			<header>
				<h1 className="text-xl font-semibold flex items-center gap-2">
					<Plug className="size-5" />
					Connectors
				</h1>
				<p className="text-sm text-text-subtle mt-1">
					Third-party services agents use — GitHub for git operations, MCP servers + skill files for
					everything else. Tokens are stored in the Hezo vault and substituted at egress; agents
					never see them.
				</p>
			</header>

			<ul className="space-y-3" data-testid="connectors-list">
				<GitHubRow teamId={teamId} connection={githubConnection} />
				{connectors
					.filter((connector) => connector.name !== 'github')
					.map((connector) => (
						<ConnectorRow
							key={connector.id}
							connector={connector}
							teamId={teamId}
							focused={connector.id === focus}
							focusRef={connector.id === focus ? focusRef : undefined}
						/>
					))}
			</ul>

			{isEmpty && (
				<p className="text-xs text-text-subtle text-center">
					No third-party MCP servers yet. When an agent calls{' '}
					<code className="px-1 py-0.5 rounded bg-bg-subtle text-xs">register_connector</code>, a
					Connect button appears here and on the task that requested it.
				</p>
			)}
		</div>
	);
}

interface GitHubRowProps {
	teamId: string;
	connection: OAuthConnection | null;
}

function GitHubRow({ teamId, connection }: GitHubRowProps) {
	const deleteConn = useDeleteOAuthConnection(teamId);
	const ensure = useEnsureConnector(teamId);
	const [deviceConnectorId, setDeviceConnectorId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const status = connection ? 'active' : 'pending';
	const connecting = ensure.isPending;

	const doRevoke = () => {
		if (!connection) return;
		if (!window.confirm(`Remove ${connection.provider_account_label}?`)) return;
		deleteConn.mutate(connection.id);
	};

	const startConnect = async () => {
		setError(null);
		try {
			const connector = await ensure.mutateAsync('github');
			setDeviceConnectorId(connector.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to start GitHub OAuth');
		}
	};

	return (
		<li
			className="rounded-lg border p-4 border-border-default"
			data-testid="connector-row"
			data-connector-name="github"
			data-status={status}
		>
			{deviceConnectorId && (
				<ConnectorDeviceFlowDialog
					open={!!deviceConnectorId}
					onOpenChange={(open) => {
						if (!open) setDeviceConnectorId(null);
					}}
					teamId={teamId}
					connectorId={deviceConnectorId}
					providerLabel="GitHub"
				/>
			)}
			<div className="flex items-start justify-between gap-4">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<Github className="size-4 shrink-0" />
						<h2 className="text-base font-medium truncate">GitHub</h2>
						<StatusBadge status={status} />
					</div>
					{connection ? (
						<>
							<p className="text-xs text-text-muted mt-1">
								Connected as <span className="font-mono">{connection.provider_account_label}</span>
							</p>
							<p className="text-xs text-text-subtle mt-1 font-mono">
								scopes: {connection.scopes.join(' ')}
							</p>
						</>
					) : (
						<p className="text-xs text-text-muted mt-1">
							One connection covers both git operations (clone, push, SSH-key registration) and the
							official GitHub MCP server (agent-callable issue/PR/search tools).
						</p>
					)}
					{error && <p className="text-xs text-accent-red-text mt-2">{error}</p>}
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{connection ? (
						<Button
							size="sm"
							variant="outline"
							onClick={doRevoke}
							disabled={deleteConn.isPending}
							data-testid="connector-revoke"
						>
							<Trash2 className="size-3.5 mr-1" />
							{deleteConn.isPending ? 'Removing…' : 'Disconnect'}
						</Button>
					) : (
						<Button
							size="sm"
							onClick={startConnect}
							disabled={connecting}
							data-testid="connector-connect"
						>
							{connecting ? 'Starting…' : 'Connect'}
						</Button>
					)}
				</div>
			</div>
		</li>
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
	const authStart = useAuthStart(teamId);
	const revoke = useRevokeConnector(teamId);
	const [error, setError] = useState<string | null>(null);
	const [deviceOpen, setDeviceOpen] = useState(false);

	const capability = getConnectorCapability(connector.name);
	const usesDeviceFlow = !!capability?.deviceAuth;

	const url =
		typeof connector.config === 'object' &&
		connector.config !== null &&
		typeof (connector.config as { url?: unknown }).url === 'string'
			? (connector.config as { url: string }).url
			: null;

	const openConnect = () => {
		setError(null);
		// Providers whose AS can't do DCR (declared via `deviceAuth`) authorize
		// through the device flow; everything else uses the redirect popup.
		if (usesDeviceFlow) {
			setDeviceOpen(true);
			return;
		}
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
			{usesDeviceFlow && deviceOpen && (
				<ConnectorDeviceFlowDialog
					open={deviceOpen}
					onOpenChange={setDeviceOpen}
					teamId={teamId}
					connectorId={connector.id}
					providerLabel={connector.display_name ?? capability?.displayName ?? connector.name}
				/>
			)}
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

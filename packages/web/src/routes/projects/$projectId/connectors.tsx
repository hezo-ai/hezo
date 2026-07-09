import { getConnectorCapability } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Check, ExternalLink, Github, KeyRound, Plug, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ConnectorApiKeyForm } from '../../../components/connector-api-key-form';
import { ConnectorDeviceFlowDialog } from '../../../components/connector-device-flow-dialog';
import { RelatedItemsList } from '../../../components/related-items-list';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InPlaceForm } from '../../../components/ui/in-place-form';
import { Input } from '../../../components/ui/input';
import {
	connectorStatus,
	type McpConnection,
	useCreateMcpConnection,
	useMcpConnections,
	useRevokeConnector,
} from '../../../hooks/use-mcp-connections';
import { useMe } from '../../../hooks/use-me';
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

export const Route = createFileRoute('/projects/$projectId/connectors')({
	validateSearch: (search: Record<string, unknown>): ConnectorsSearch => ({
		focus: typeof search.focus === 'string' ? search.focus : undefined,
	}),
	component: ConnectorsPage,
});

function ConnectorsPage() {
	const { projectId } = Route.useParams();
	const { focus } = Route.useSearch();
	const { data: connectors = [] } = useMcpConnections(projectId);
	const { data: oauthConnections = [] } = useOAuthConnections(projectId);

	// Ref callback fires when the focused <li> mounts (which can happen after
	// the initial render once the connectors query resolves). Scrolls into view
	// then; no dependency-array gymnastics needed.
	const focusRef = useCallback((el: HTMLLIElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	const githubConnection = oauthConnections.find((c) => c.provider === 'github') ?? null;
	const isEmpty = connectors.length === 0 && oauthConnections.length === 0;

	const [showAdd, setShowAdd] = useState(false);

	return (
		<div className="space-y-6 max-w-4xl">
			<header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h1 className="text-xl font-semibold flex items-center gap-2">
						<Plug className="size-5" />
						Connectors
					</h1>
					<p className="text-sm text-text-3 mt-1">
						Third-party services agents use — GitHub for git operations, MCP servers + skill files
						for everything else. Tokens are stored in the Hezo vault and substituted at egress;
						agents never see them.
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => setShowAdd((s) => !s)}
					className="shrink-0 self-start"
					data-testid="connector-add-toggle"
				>
					<Plus className="size-3.5 mr-1" /> Add
				</Button>
			</header>

			{showAdd && <AddConnectorForm projectId={projectId} onClose={() => setShowAdd(false)} />}

			<ul className="space-y-3" data-testid="connectors-list">
				<GitHubRow projectId={projectId} connection={githubConnection} />
				{connectors
					.filter((connector) => connector.name !== 'github')
					.map((connector) => (
						<ConnectorRow
							key={connector.id}
							connector={connector}
							projectId={projectId}
							focused={connector.id === focus}
							focusRef={connector.id === focus ? focusRef : undefined}
						/>
					))}
			</ul>

			{isEmpty && (
				<p className="text-xs text-text-3 text-center">
					No third-party MCP servers yet. Add one above, or when an agent calls{' '}
					<code className="px-1 py-0.5 rounded bg-surface-2 text-xs">register_connector</code>, a
					Connect button appears here and on the task that requested it.
				</p>
			)}
		</div>
	);
}

interface AddConnectorFormProps {
	projectId: string;
	onClose: () => void;
}

/**
 * Add a remote (SaaS) MCP connector directly to this project — the same
 * name+URL create the admin page offers, scoped implicitly to this project.
 * On submit it creates the row, then probes for OAuth: an OAuth-capable server
 * opens the authorize popup automatically; a public / header-authenticated one
 * resolves to a null auth_url and the new row just offers its API-key option.
 */
function AddConnectorForm({ projectId, onClose }: AddConnectorFormProps) {
	const create = useCreateMcpConnection(projectId);
	const authStart = useAuthStart(projectId);
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	const [error, setError] = useState<string | null>(null);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!name.trim() || !url.trim()) {
			setError('Name and MCP server URL are required.');
			return;
		}
		let created: McpConnection;
		try {
			created = await create.mutateAsync({
				name: name.trim(),
				kind: 'saas',
				config: { url: url.trim() },
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add connector');
			return;
		}
		// The row already shows in the list; probe the new connector for OAuth and
		// pop the authorize window when it advertises any. Header-auth / public MCPs
		// resolve to auth_url null and are connected later with a pasted API key from
		// their row, so those just close the form. Keep the form open only to surface
		// a blocked popup (its error can't render once the form unmounts).
		try {
			const started = await authStart.mutateAsync(created.id);
			if (started.auth_url) {
				const popup = window.open(started.auth_url, 'hezo-connect', 'width=600,height=720');
				if (!popup) {
					setError('Pop-up blocked. Allow pop-ups for Hezo and try again.');
					return;
				}
			}
		} catch {
			// The row exists regardless; any auth failure is recorded on it (Failed
			// badge + Retry), so the user can connect from the row itself.
		}
		onClose();
	};

	return (
		<InPlaceForm
			title="Add connector"
			onClose={onClose}
			onSubmit={submit}
			data-testid="connector-add-form"
		>
			<Input
				placeholder="Name (e.g. linear)"
				value={name}
				onChange={(e) => setName(e.target.value)}
				data-testid="connector-add-name"
				required
			/>
			<Input
				placeholder="MCP server URL (e.g. https://mcp.example.com/mcp)"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				data-testid="connector-add-url"
				required
			/>
			{error && <p className="text-xs text-danger-soft-fg">{error}</p>}
			<div className="flex gap-2">
				<Button
					type="submit"
					size="sm"
					disabled={create.isPending}
					data-testid="connector-add-submit"
				>
					{create.isPending ? 'Adding…' : 'Add connector'}
				</Button>
				<Button type="button" size="sm" variant="secondary" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</InPlaceForm>
	);
}

interface GitHubRowProps {
	projectId: string;
	connection: OAuthConnection | null;
}

function GitHubRow({ projectId, connection }: GitHubRowProps) {
	const deleteConn = useDeleteOAuthConnection(projectId);
	const ensure = useEnsureConnector(projectId);
	const [deviceConnectorId, setDeviceConnectorId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const status = connection ? 'active' : 'pending';
	const connecting = ensure.isPending;

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
			className="rounded-lg border p-4 border-border"
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
					projectId={projectId}
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
							<p className="text-xs text-text-2 mt-1">
								Connected as <span className="font-mono">{connection.provider_account_label}</span>
							</p>
							<p className="text-xs text-text-3 mt-1 font-mono">
								scopes: {connection.scopes.join(' ')}
							</p>
						</>
					) : (
						<p className="text-xs text-text-2 mt-1">
							One connection covers both git operations (clone, push, SSH-key registration) and the
							official GitHub MCP server (agent-callable issue/PR/search tools).
						</p>
					)}
					{error && <p className="text-xs text-danger-soft-fg mt-2">{error}</p>}
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{connection ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setConfirmOpen(true)}
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
			{connection && (
				<ConfirmDialog
					open={confirmOpen}
					onOpenChange={setConfirmOpen}
					title="Disconnect GitHub?"
					description={
						<>
							Remove the GitHub connection{' '}
							<span className="font-mono">{connection.provider_account_label}</span>? Git operations
							and the GitHub MCP server will stop working for this project.
						</>
					}
					confirmLabel="Disconnect"
					variant="danger"
					onConfirm={async () => {
						await deleteConn.mutateAsync(connection.id);
					}}
				/>
			)}
		</li>
	);
}

interface ConnectorRowProps {
	connector: McpConnection;
	projectId: string;
	focused: boolean;
	focusRef?: (el: HTMLLIElement | null) => void;
}

function ConnectorRow({ connector, projectId, focused, focusRef }: ConnectorRowProps) {
	const { data: me } = useMe();
	const status = connectorStatus(connector);
	const authStart = useAuthStart(projectId);
	const revoke = useRevokeConnector(projectId);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [deviceOpen, setDeviceOpen] = useState(false);
	const [showApiKey, setShowApiKey] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const credentials = connector.credentials ?? [];
	// The credentials page is superuser-only, so link there only for a superuser;
	// members see the credential name as plain text.
	const isSuperuser = !!me?.is_superuser;

	const capability = getConnectorCapability(connector.name);
	const usesDeviceFlow = !!capability?.deviceAuth;
	// Global connectors (project_id null) are shared across every project and
	// managed on the global /settings/connectors page — they are read-only here:
	// no connect/disconnect/api-key, just a "Global" badge and a link to manage.
	const isGlobal = connector.project_id === null;

	const url =
		typeof connector.config === 'object' &&
		connector.config !== null &&
		typeof (connector.config as { url?: unknown }).url === 'string'
			? (connector.config as { url: string }).url
			: null;

	const openConnect = () => {
		setError(null);
		setInfo(null);
		// Providers whose AS can't do DCR (declared via `deviceAuth`) authorize
		// through the device flow; everything else uses the redirect popup.
		if (usesDeviceFlow) {
			setDeviceOpen(true);
			return;
		}
		authStart.mutate(connector.id, {
			onSuccess: ({ auth_url }) => {
				// A null auth_url means the server advertises no OAuth (public /
				// header-authenticated) — not an error: point the user at the API key.
				if (!auth_url) {
					setInfo("This MCP server doesn't advertise OAuth — connect it with the API key option.");
					return;
				}
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

	const doRevoke = async () => {
		setError(null);
		try {
			await revoke.mutateAsync(connector.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to revoke');
		}
	};

	return (
		<li
			ref={focusRef}
			id={connector.id}
			className={`rounded-lg border p-4 transition-colors ${
				focused ? 'border-info bg-info-soft' : 'border-border'
			}`}
			data-testid="connector-row"
			data-connector-id={connector.id}
			data-status={status}
		>
			{usesDeviceFlow && deviceOpen && (
				<ConnectorDeviceFlowDialog
					open={deviceOpen}
					onOpenChange={setDeviceOpen}
					projectId={projectId}
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
						{isGlobal && (
							<Badge
								className="bg-neutral-soft text-neutral-soft-fg"
								testId="connector-global-badge"
							>
								Global
							</Badge>
						)}
					</div>
					{url && <p className="text-xs text-text-2 mt-1 truncate font-mono">{url}</p>}
					{connector.oauth_account_label && (
						<p className="text-xs text-text-2 mt-1">
							Connected as <span className="font-mono">{connector.oauth_account_label}</span>
						</p>
					)}
					{connector.skill_id && (
						<p className="text-xs text-text-2 mt-1 flex items-center gap-1">
							<ExternalLink className="size-3" />
							Skill file imported
						</p>
					)}
					{connector.auth_error && status !== 'active' && (
						<p className="text-xs text-danger-soft-fg mt-2">{connector.auth_error}</p>
					)}
					{error && <p className="text-xs text-danger-soft-fg mt-2">{error}</p>}
					{info && <p className="text-xs text-text-3 mt-2">{info}</p>}
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{isGlobal ? (
						// Read-only here: manage global connectors on the global page.
						<Link
							to="/settings/connectors"
							className="flex items-center gap-1 text-xs text-text-3 hover:text-text-1"
							data-testid="connector-global-manage-link"
						>
							Manage <ExternalLink className="size-3" />
						</Link>
					) : status === 'active' ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setConfirmOpen(true)}
							disabled={revoke.isPending}
							data-testid="connector-revoke"
						>
							<Trash2 className="size-3.5 mr-1" />
							{revoke.isPending ? 'Revoking…' : 'Disconnect'}
						</Button>
					) : (
						<>
							<Button
								size="sm"
								onClick={openConnect}
								disabled={authStart.isPending}
								data-testid="connector-connect"
							>
								{authStart.isPending ? 'Starting…' : status === 'failed' ? 'Retry' : 'Connect'}
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setShowApiKey((v) => !v)}
								data-testid="connector-api-key-toggle"
							>
								<KeyRound className="size-3.5 mr-1" />
								API key
							</Button>
						</>
					)}
				</div>
			</div>

			{!isGlobal && status !== 'active' && showApiKey && (
				<div className="mt-3 pt-3 border-t border-border">
					<ConnectorApiKeyForm
						projectId={projectId}
						connectorId={connector.id}
						onSuccess={() => setShowApiKey(false)}
						onCancel={() => setShowApiKey(false)}
					/>
				</div>
			)}

			{credentials.length > 0 && (
				<div className="mt-3">
					<RelatedItemsList
						label="Credentials"
						testId={`connector-credentials-${connector.id}`}
						items={credentials.map((cred) => ({
							key: cred.id,
							label: cred.name,
							href: isSuperuser ? `/settings/credentials?focus=${cred.id}#${cred.id}` : undefined,
							testId: `connector-credential-link-${cred.id}`,
						}))}
					/>
				</div>
			)}

			{connector.created_by_task_id && (
				<div className="mt-3 pt-3 border-t border-border text-xs text-text-2">
					Requested by an agent.{' '}
					<Link
						to="/projects/$projectId/tasks/$taskId"
						params={{ projectId, taskId: connector.created_by_task_id }}
						className="underline hover:text-text-1"
					>
						View task
					</Link>
				</div>
			)}

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Disconnect connector?"
				description={
					<>
						Revoke <span className="font-medium">{connector.display_name ?? connector.name}</span>?
						Agents will lose access immediately.
					</>
				}
				confirmLabel="Disconnect"
				variant="danger"
				onConfirm={doRevoke}
			/>
		</li>
	);
}

function StatusBadge({ status }: { status: 'pending' | 'active' | 'failed' | 'revoked' }) {
	if (status === 'active') {
		return (
			<Badge className="bg-success-soft text-success-soft-fg border-success">
				<Check className="size-3 mr-0.5 inline" />
				Connected
			</Badge>
		);
	}
	if (status === 'failed') {
		return (
			<Badge className="bg-danger-soft text-danger-soft-fg border-danger">
				<X className="size-3 mr-0.5 inline" />
				Failed
			</Badge>
		);
	}
	if (status === 'revoked') {
		return <Badge>Revoked</Badge>;
	}
	return (
		<Badge className="bg-warning-soft text-warning-soft-fg border-warning">Pending connect</Badge>
	);
}

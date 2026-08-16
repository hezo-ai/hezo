import { getConnectorCapability, isReadOnlyRestricted } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AlertTriangle, Check, ExternalLink, Github, Plug, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ConnectorDeviceFlowDialog } from '../../../components/connector-device-flow-dialog';
import { ConnectorOAuthBrokerForm } from '../../../components/connector-oauth-broker-form';
import { ConnectorSettingsSection } from '../../../components/connector-settings-section';
import { InfiniteScrollSentinel } from '../../../components/infinite-scroll-sentinel';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { InPlaceForm } from '../../../components/ui/in-place-form';
import { Input } from '../../../components/ui/input';
import {
	type Connector,
	type ConnectorStatus,
	connectorStatus,
	useConnectors,
	useCreateConnector,
	useDeleteConnector,
	useRevokeConnector,
} from '../../../hooks/use-connectors';
import { useMe } from '../../../hooks/use-me';
import {
	type OAuthConnection,
	useAuthStart,
	useDeleteOAuthConnection,
	useEnsureConnector,
	useOAuthConnections,
} from '../../../hooks/use-oauth-connections';
import { useOAuthSuccessRefetch } from '../../../hooks/use-oauth-success';
import { useProject } from '../../../hooks/use-projects';
import { useI18n } from '../../../lib/i18n';
import { queryKeys } from '../../../lib/query-keys';

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
	const {
		data: connectorPages,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useConnectors(projectId);
	const connectors = useMemo(
		() => connectorPages?.pages.flatMap((p) => p.data) ?? [],
		[connectorPages],
	);
	const { data: oauthConnections = [] } = useOAuthConnections(projectId);

	// A (re)connection completes inside the OAuth popup, so this tab learns about
	// it either from the popup's postMessage or from the connector's row-change
	// broadcast. Listen for the first: it lands as soon as the popup closes,
	// without waiting on the WebSocket round trip.
	useOAuthSuccessRefetch(queryKeys.projects.connectors(projectId));

	// Ref callback fires when the focused <li> mounts (which can happen after
	// the initial render once the connectors query resolves). Scrolls into view
	// then; no dependency-array gymnastics needed.
	const focusRef = useCallback((el: HTMLLIElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	const githubConnection = oauthConnections.find((c) => c.provider === 'github') ?? null;
	const isEmpty = connectors.length === 0 && oauthConnections.length === 0;

	// GitHub is offered on every project, but it is only a *setup step* for a team that
	// actually does git work. A team whose roster has no `touches_code` agent never trips
	// the repo-setup gate, so an amber "Pending connect" would be inviting the operator to
	// finish something that will never be needed. Any one of these promotes it back:
	// a code-touching agent is hired, a repo is attached, or GitHub is connected anyway.
	const { data: project, isPending: projectPending } = useProject(projectId);
	const gitRelevant =
		(project?.code_agent_count ?? 0) > 0 ||
		(project?.repo_count ?? 0) > 0 ||
		githubConnection !== null;
	// Hold the row back until the project resolves so it doesn't render at the top and
	// then jump to the bottom (or vice versa) one tick later.
	const githubRow = projectPending ? null : (
		<GitHubRow projectId={projectId} connection={githubConnection} optional={!gitRelevant} />
	);

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
				{gitRelevant && githubRow}
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
				{!gitRelevant && githubRow}
			</ul>

			<InfiniteScrollSentinel
				hasNextPage={hasNextPage}
				isFetchingNextPage={isFetchingNextPage}
				onLoadMore={fetchNextPage}
				testId="connectors"
			/>

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
 * Add a connector directly to this project. Two transports:
 *  - MCP server (`saas`): name + URL; on submit it creates the row then probes
 *    for OAuth (OAuth-capable → authorize popup; public/header-auth → null
 *    auth_url and the row offers its API-key option).
 *  - REST API (`api`): a direct HTTP API the agent calls itself (no MCP server) —
 *    base URL + allowed hosts + how the credential rides (header/query). No OAuth;
 *    the human attaches the key from the new row and the egress proxy substitutes
 *    it, scoped to the allowed hosts.
 */
function AddConnectorForm({ projectId, onClose }: AddConnectorFormProps) {
	const create = useCreateConnector(projectId);
	const authStart = useAuthStart(projectId);
	const [type, setType] = useState<'mcp' | 'api'>('mcp');
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	// REST-API-connector fields.
	const [baseUrl, setBaseUrl] = useState('');
	const [allowedHosts, setAllowedHosts] = useState('');
	const [placement, setPlacement] = useState<'header' | 'query'>('header');
	const [authName, setAuthName] = useState('Authorization');
	const [scheme, setScheme] = useState('Bearer ');
	const [docsUrl, setDocsUrl] = useState('');
	const [error, setError] = useState<string | null>(null);

	const submitMcp = async () => {
		if (!name.trim() || !url.trim()) {
			setError('Name and MCP server URL are required.');
			return;
		}
		let created: Connector;
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
		// Probe the new connector for OAuth and pop the authorize window when it
		// advertises any. Header-auth / public MCPs resolve to auth_url null and are
		// connected later with a pasted API key from their row. Keep the form open
		// only to surface a blocked popup (its error can't render once unmounted).
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
			// The row exists regardless; any auth failure is recorded on it.
		}
		onClose();
	};

	const submitApi = async () => {
		const hosts = allowedHosts
			.split(/[\s,]+/)
			.map((h) => h.trim())
			.filter(Boolean);
		if (!name.trim() || !baseUrl.trim()) {
			setError('Name and base URL are required.');
			return;
		}
		if (hosts.length === 0) {
			setError('At least one allowed host is required (the egress proxy scope for the key).');
			return;
		}
		if (!authName.trim()) {
			setError(
				placement === 'header' ? 'Header name is required.' : 'Query parameter is required.',
			);
			return;
		}
		try {
			await create.mutateAsync({
				name: name.trim(),
				kind: 'api',
				config: {
					base_url: baseUrl.trim(),
					allowed_hosts: hosts,
					auth: {
						placement,
						name: authName.trim(),
						...(placement === 'header' && scheme !== '' ? { scheme } : {}),
					},
					...(docsUrl.trim() ? { docs_url: docsUrl.trim() } : {}),
				},
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add API connector');
			return;
		}
		// No OAuth for a direct-API connector — the human attaches the credential
		// from the new row (API key), which scopes the vault secret to allowed_hosts.
		onClose();
	};

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (type === 'mcp') void submitMcp();
		else void submitApi();
	};

	return (
		<InPlaceForm
			title="Add connector"
			onClose={onClose}
			onSubmit={submit}
			data-testid="connector-add-form"
		>
			<div className="flex gap-2">
				<Button
					type="button"
					size="sm"
					variant={type === 'mcp' ? undefined : 'outline'}
					onClick={() => setType('mcp')}
					data-testid="connector-add-type-mcp"
				>
					MCP server
				</Button>
				<Button
					type="button"
					size="sm"
					variant={type === 'api' ? undefined : 'outline'}
					onClick={() => setType('api')}
					data-testid="connector-add-type-api"
				>
					REST API
				</Button>
			</div>
			<Input
				placeholder="Name (e.g. linear)"
				value={name}
				onChange={(e) => setName(e.target.value)}
				data-testid="connector-add-name"
				required
			/>
			{type === 'mcp' ? (
				<Input
					placeholder="MCP server URL (e.g. https://mcp.example.com/mcp)"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					data-testid="connector-add-url"
				/>
			) : (
				<>
					<Input
						placeholder="Base URL (e.g. https://api.example.com/v1)"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						data-testid="connector-add-base-url"
					/>
					<Input
						placeholder="Allowed hosts, comma/space separated (e.g. api.example.com)"
						value={allowedHosts}
						onChange={(e) => setAllowedHosts(e.target.value)}
						data-testid="connector-add-allowed-hosts"
					/>
					<div className="flex flex-col gap-2 sm:flex-row">
						<select
							value={placement}
							onChange={(e) => setPlacement(e.target.value as 'header' | 'query')}
							data-testid="connector-add-placement"
							className="rounded-md border border-border bg-transparent px-2 py-2 text-sm text-text-1 shrink-0"
						>
							<option value="header">Header</option>
							<option value="query">Query param</option>
						</select>
						<Input
							placeholder={
								placement === 'header' ? 'Header name (Authorization)' : 'Query param (api_key)'
							}
							value={authName}
							onChange={(e) => setAuthName(e.target.value)}
							data-testid="connector-add-auth-name"
						/>
						{placement === 'header' && (
							<Input
								placeholder="Scheme prefix (e.g. 'Bearer ')"
								value={scheme}
								onChange={(e) => setScheme(e.target.value)}
								data-testid="connector-add-scheme"
							/>
						)}
					</div>
					<Input
						placeholder="API docs URL (optional)"
						value={docsUrl}
						onChange={(e) => setDocsUrl(e.target.value)}
						data-testid="connector-add-docs-url"
					/>
					<p className="text-xs text-text-3">
						A direct REST API the agent calls itself — no MCP server. After creating, attach the API
						key from its row; agents get the placeholder + base URL via <code>list_connectors</code>{' '}
						and the egress proxy substitutes the key, scoped to the allowed hosts.
					</p>
				</>
			)}
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
	/** No agent on this team touches code, so GitHub is an extra rather than a setup step. */
	optional?: boolean;
}

function GitHubRow({ projectId, connection, optional = false }: GitHubRowProps) {
	const deleteConn = useDeleteOAuthConnection(projectId);
	const ensure = useEnsureConnector(projectId);
	const [deviceConnectorId, setDeviceConnectorId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const status = connection ? 'active' : optional ? 'optional' : 'pending';
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
			className={`rounded-lg border p-4 ${optional ? 'border-dashed border-border/60' : 'border-border'}`}
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
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
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
					) : optional ? (
						<p className="text-xs text-text-3 mt-1">
							No agents on this team touch code, so nothing here needs a repo. Connect GitHub only
							if you want agents to work with repos or call the GitHub MCP server.
						</p>
					) : (
						<p className="text-xs text-text-2 mt-1">
							One connection covers both git operations (clone, push, SSH-key registration) and the
							official GitHub MCP server (agent-callable issue/PR/search tools).
						</p>
					)}
					{error && <p className="text-xs text-danger-soft-fg mt-2">{error}</p>}
				</div>

				<div className="flex flex-wrap items-center gap-2 sm:shrink-0">
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
	connector: Connector;
	projectId: string;
	focused: boolean;
	focusRef?: (el: HTMLLIElement | null) => void;
}

function ConnectorRow({ connector, projectId, focused, focusRef }: ConnectorRowProps) {
	const { t } = useI18n();
	const { data: me } = useMe();
	const queryClient = useQueryClient();
	const status = connectorStatus(connector);
	const authStart = useAuthStart(projectId);
	const revoke = useRevokeConnector(projectId);
	const del = useDeleteConnector(projectId);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [deviceOpen, setDeviceOpen] = useState(false);
	const [brokerOpen, setBrokerOpen] = useState(false);
	// A static-key `api` connector (query-placement credential) leads with the
	// API-key form — the Settings section opens it by default so the paste field
	// is the primary action.
	const leadsWithApiKey =
		connector.kind === 'api' &&
		(connector.config as { auth?: { placement?: unknown } } | null)?.auth?.placement === 'query';
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
	// The credentials page is superuser-only, so link there only for a superuser;
	// members see the credential name as plain text.
	const isSuperuser = !!me?.is_superuser;

	const capability = getConnectorCapability(connector.name);
	const usesDeviceFlow = !!capability?.deviceAuth;
	// Global connectors (project_id null) are shared across every project and
	// managed on the global /settings/connectors page — they are read-only here:
	// no connect/disconnect/api-key, just a "Global" badge and a link to manage.
	const isGlobal = connector.project_id === null;

	const cfg = (connector.config ?? {}) as {
		url?: unknown;
		base_url?: unknown;
		docs_url?: unknown;
		oauth_provider_id?: unknown;
		auth?: { placement?: unknown };
	};
	const url = typeof cfg.url === 'string' ? cfg.url : null;
	const baseUrl = typeof cfg.base_url === 'string' ? cfg.base_url : null;
	const docsUrl = typeof cfg.docs_url === 'string' ? cfg.docs_url : null;
	const oauthProviderId =
		typeof cfg.oauth_provider_id === 'string' && cfg.oauth_provider_id
			? cfg.oauth_provider_id
			: undefined;
	const isApi = connector.kind === 'api';
	// A query-string credential is never an OAuth access token (those ride a Bearer
	// header), so a query-placement `api` connector is unambiguously a static-key
	// REST API — lead with the API-key form and hide the OAuth broker for it.
	const isStaticKeyApi = isApi && cfg.auth?.placement === 'query';
	const displayUrl = url ?? baseUrl;
	// Badge the card only when every write method the server advertises is off —
	// a server with no write methods was never narrowed, so calling it read-only
	// would overstate what the operator actually did.
	const readOnly = isReadOnlyRestricted(
		connector.discovered_methods ?? [],
		connector.enabled_methods ?? null,
	);

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

	const doRemove = async () => {
		setError(null);
		try {
			await del.mutateAsync(connector.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to remove');
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
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<h2 className="text-base font-medium truncate">
							{connector.display_name ?? connector.name}
						</h2>
						<StatusBadge status={status} />
						{readOnly && (
							<Badge className="bg-info-soft text-info-soft-fg" testId="connector-read-only-badge">
								Read-only
							</Badge>
						)}
						{isGlobal && (
							<Badge
								className="bg-neutral-soft text-neutral-soft-fg"
								testId="connector-global-badge"
							>
								Global
							</Badge>
						)}
					</div>
					{displayUrl && (
						<p className="text-xs text-text-2 mt-1 truncate font-mono">{displayUrl}</p>
					)}
					{docsUrl && (
						<a
							href={docsUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-info hover:underline mt-1 inline-flex items-center gap-1"
							data-testid="connector-docs-link"
						>
							<ExternalLink className="size-3" /> API docs
						</a>
					)}
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
					{/* Shown for an active connector too: a token whose refresh keeps
					    failing leaves the row activated but unusable, and the error is
					    the only signal the operator gets. Cleared on reconnect. */}
					{connector.auth_error && (
						<p className="text-xs text-danger-soft-fg mt-2">{connector.auth_error}</p>
					)}
					{error && <p className="text-xs text-danger-soft-fg mt-2">{error}</p>}
					{info && <p className="text-xs text-text-3 mt-2">{info}</p>}
				</div>

				<div
					className="flex flex-wrap items-center gap-2 sm:shrink-0"
					data-testid="connector-actions"
				>
					{isGlobal ? (
						// Read-only here: manage global connectors on the global page.
						<Link
							to="/settings/connectors"
							className="flex items-center gap-1 text-xs text-text-3 hover:text-text-1"
							data-testid="connector-global-manage-link"
						>
							Manage <ExternalLink className="size-3" />
						</Link>
					) : status === 'active' || status === 'degraded' ? (
						<>
							{/* A degraded connector's credential is dead and only a human can
							    replace it, so the reconnect affordance has to live here in the
							    connected branch — it used to exist only in the not-connected
							    branch below, which a stale-token row never reached, leaving
							    Disconnect as the only button on a connector the operator
							    wanted to fix. `auth-start` re-runs cleanly on an active row
							    (cached DCR is reused) and a completed re-auth clears
							    auth_error, so this self-heals the state. */}
							{status === 'degraded' &&
								(isApi ? (
									!isStaticKeyApi &&
									!brokerOpen && (
										<Button
											size="sm"
											onClick={() => setBrokerOpen(true)}
											data-testid="connector-reconnect"
										>
											<Plug className="size-3.5 mr-1" />
											{t('connectors.reconnect')}
										</Button>
									)
								) : (
									<Button
										size="sm"
										onClick={openConnect}
										disabled={authStart.isPending}
										data-testid="connector-reconnect"
									>
										{authStart.isPending ? 'Starting…' : t('connectors.reconnect')}
									</Button>
								))}
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
						</>
					) : (
						<>
							{!isApi && (
								<Button
									size="sm"
									onClick={openConnect}
									disabled={authStart.isPending}
									data-testid="connector-connect"
								>
									{authStart.isPending
										? 'Starting…'
										: status === 'failed'
											? t('common.retry')
											: 'Connect'}
								</Button>
							)}
							{isApi && !isStaticKeyApi && !brokerOpen && (
								<Button
									size="sm"
									onClick={() => setBrokerOpen(true)}
									data-testid="connector-oauth-broker"
								>
									<Plug className="size-3.5 mr-1" />
									Complete connection
								</Button>
							)}
							<Button
								size="sm"
								variant="outline"
								onClick={() => setRemoveConfirmOpen(true)}
								disabled={del.isPending}
								data-testid="connector-remove"
							>
								<Trash2 className="size-3.5 mr-1" />
								{del.isPending ? 'Removing…' : 'Remove'}
							</Button>
						</>
					)}
				</div>
			</div>

			{/* Inline OAuth device-flow completion for an OAuth-backed `api` connector —
			    the same broker form the task comment shows, with the agent-preset
			    provider locked (or a manual picker when none). A static-key api
			    connector (query-placement) never shows this; it leads with the API key. */}
			{isApi && !isStaticKeyApi && !isGlobal && status !== 'active' && brokerOpen && (
				<div className="mt-3 pt-3 border-t border-border" data-testid="connector-complete-inline">
					<ConnectorOAuthBrokerForm
						projectId={projectId}
						connectorId={connector.id}
						connectorLabel={connector.display_name ?? connector.name}
						lockedProviderId={oauthProviderId}
						layout="inline"
						onSuccess={() => {
							setBrokerOpen(false);
							queryClient.invalidateQueries({
								queryKey: queryKeys.projects.connectors(projectId),
							});
						}}
						onCancel={() => setBrokerOpen(false)}
					/>
				</div>
			)}

			<ConnectorSettingsSection
				connector={connector}
				projectId={projectId}
				status={status}
				isGlobal={isGlobal}
				isSuperuser={isSuperuser}
				initialApiKeyOpen={leadsWithApiKey}
			/>

			{connector.created_by_task_identifier && (
				<div className="mt-3 pt-3 border-t border-border text-xs text-text-2">
					Requested by an agent in{' '}
					<Link
						to="/projects/$projectId/tasks/$taskId"
						params={{ projectId, taskId: connector.created_by_task_identifier }}
						className="underline hover:text-text-1"
					>
						{connector.created_by_task_title ?? 'View task'}
						<span className="ml-1.5 font-mono uppercase text-text-3">
							{connector.created_by_task_identifier}
						</span>
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

			<ConfirmDialog
				open={removeConfirmOpen}
				onOpenChange={setRemoveConfirmOpen}
				title="Remove connector?"
				description={
					<>
						Remove <span className="font-medium">{connector.display_name ?? connector.name}</span>?
						This deletes it from this project. An agent can request it again if needed.
					</>
				}
				confirmLabel="Remove"
				variant="danger"
				onConfirm={doRemove}
			/>
		</li>
	);
}

function StatusBadge({ status }: { status: ConnectorStatus | 'optional' }) {
	const { t } = useI18n();
	if (status === 'active') {
		return (
			<Badge className="bg-success-soft text-success-soft-fg border-success">
				<Check className="size-3 mr-0.5 inline" />
				Connected
			</Badge>
		);
	}
	// Distinct from `failed`: this one WAS connected, so the remedy is a
	// reconnect rather than a first-time setup. Warning tone, not danger - the
	// connector is recoverable in one click and nothing is lost.
	if (status === 'degraded') {
		return (
			<Badge
				className="bg-warning-soft text-warning-soft-fg border-warning"
				testId="connector-degraded-badge"
			>
				<AlertTriangle className="size-3 mr-0.5 inline" />
				{t('connectors.status.needsReconnect')}
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
	// Deliberately neutral, not the warning colours below - "optional" is a resting
	// state, not an unfinished setup step.
	if (status === 'optional') {
		return <Badge>Optional</Badge>;
	}
	return (
		<Badge className="bg-warning-soft text-warning-soft-fg border-warning">Pending connect</Badge>
	);
}

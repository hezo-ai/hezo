import { summarizeMethodAccess } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectorMethodsDialog } from '../../components/connector-methods-dialog';
import { InfiniteScrollSentinel } from '../../components/infinite-scroll-sentinel';
import { RelatedItemsList } from '../../components/related-items-list';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InPlaceForm } from '../../components/ui/in-place-form';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	SearchableSelect,
	type SearchableSelectOption,
} from '../../components/ui/searchable-select';
import {
	type Connector,
	connectorStatus,
	useConnectorMethods,
	useRefreshConnectorMethods,
} from '../../hooks/use-connectors';
import {
	INSTANCE_CONNECTORS_KEY,
	useCreateInstanceConnector,
	useDeleteInstanceConnector,
	useInstanceAuthStart,
	useInstanceConnectors,
	useUpdateInstanceConnectorScope,
} from '../../hooks/use-instance-connectors';
import { useMe } from '../../hooks/use-me';
import { useAllVisibleProjects } from '../../hooks/use-projects';

// Scope sentinel: create against / re-scope to "all projects" (a global
// connector, project_id null). Any other option value is a concrete project id.
const ALL_PROJECTS = 'all';

function openAuthPopup(authUrl: string): string | null {
	const popup = window.open(authUrl, 'hezo-connect', 'width=600,height=720');
	return popup ? null : 'Pop-up blocked. Allow pop-ups for Hezo and try again.';
}

function InstanceConnectorsPage() {
	const { data: me } = useMe();
	const { focus } = Route.useSearch();
	const {
		data: connectorPages,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useInstanceConnectors();
	const connectors = useMemo(
		() => connectorPages?.pages.flatMap((p) => p.data) ?? [],
		[connectorPages],
	);
	const { projects } = useAllVisibleProjects();
	const createConnector = useCreateInstanceConnector();
	const authStart = useInstanceAuthStart();
	const queryClient = useQueryClient();

	// Ref callback fires when the focused row mounts (which can happen after the
	// initial render once the connectors query resolves). Scrolls into view then.
	const focusRef = useCallback((el: HTMLDivElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	// Scope picked in the Add form for the new connector (`all` = global).
	const [createScope, setCreateScope] = useState<string>(ALL_PROJECTS);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	const [error, setError] = useState<string | null>(null);

	// Shared "All projects" + every project — drives both the create-form scope
	// picker and each row's inline re-scope dropdown.
	const scopeOptions = useMemo<SearchableSelectOption[]>(
		() => [
			{ value: ALL_PROJECTS, label: 'All projects' },
			...projects.map((p) => ({ value: p.id, label: p.name, description: p.teamName })),
		],
		[projects],
	);
	const createScopeName =
		createScope === ALL_PROJECTS
			? null
			: (projects.find((p) => p.id === createScope)?.name ?? 'this project');

	function closeForm() {
		setShowForm(false);
		setError(null);
	}

	// Refetch the list when the OAuth popup signals success. The popup posts
	// {type: 'hezo-oauth-success'} via window.opener.postMessage from the
	// callback page (routes/oauth.ts:buildCallbackPage), which lives on the
	// server origin while we're on the web origin — so we can't require
	// e.origin === window.location.origin and gate on message type instead.
	// The payload is just a type tag, not credentials.
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (!e.data || typeof e.data !== 'object') return;
			if ((e.data as { type?: string }).type !== 'hezo-oauth-success') return;
			queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTORS_KEY });
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [queryClient]);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!name.trim() || !url.trim()) {
			setError('Name and MCP server URL are required.');
			return;
		}
		let created: Connector;
		try {
			created = await createConnector.mutateAsync({
				name: name.trim(),
				kind: 'saas',
				config: { url: url.trim() },
				project_id: createScope === ALL_PROJECTS ? null : createScope,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create connector');
			return;
		}
		setName('');
		setUrl('');
		setShowForm(false);
		// Probe the new connector for OAuth support and pop the authorize window
		// when it advertises any; header-auth/public MCPs resolve to
		// auth_url null and need nothing further.
		try {
			const started = await authStart.mutateAsync(created.id);
			if (started.auth_url) {
				const popupError = openAuthPopup(started.auth_url);
				if (popupError) setError(popupError);
			}
		} catch (err) {
			// The row exists either way; the failure is also recorded on it as
			// auth_error (Failed badge + Retry), so this is just immediate feedback.
			setError(err instanceof Error ? err.message : 'Failed to start OAuth');
		}
	}

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Instance connectors are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">Connectors</h1>
							<InfoTooltip
								label="About connectors"
								content="Servers that advertise OAuth get a connect popup when added; for the rest, authenticate headers with a shared credential placeholder (__HEZO_SECRET_NAME__)."
								data-testid="connectors-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							Remote (SaaS) MCP servers across every project. Each project's runs see its own
							connectors plus any scoped to "All projects".
						</p>
					</div>
					<Button variant="secondary" size="sm" onClick={() => setShowForm((s) => !s)}>
						<Plus className="w-3 h-3" /> Add
					</Button>
				</div>

				{showForm && (
					<InPlaceForm
						title={
							createScope === ALL_PROJECTS
								? 'Add connector (All projects)'
								: `Add connector — ${createScopeName}`
						}
						onClose={closeForm}
						onSubmit={handleCreate}
					>
						<Input
							placeholder="Name (e.g. shared-docs)"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
						/>
						<Input
							placeholder="MCP server URL (e.g. https://mcp.example.com/mcp)"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							required
						/>
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-[13px] text-text-2">Scope</span>
							<SearchableSelect
								options={scopeOptions}
								value={createScope}
								onChange={setCreateScope}
								searchPlaceholder="Search projects…"
								emptyLabel="No projects"
								testId="create-scope-select"
							/>
						</div>
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={createConnector.isPending}>
								Add connector
							</Button>
							<Button type="button" variant="secondary" size="sm" onClick={closeForm}>
								Cancel
							</Button>
						</div>
					</InPlaceForm>
				)}

				{/* Rendered outside the form: the OAuth kickoff runs after the form
				    closes, so popup-blocked / auth-start errors need a home too. */}
				{error && <p className="text-[13px] text-danger mb-4">{error}</p>}

				{!connectors.length ? (
					<p className="text-[13px] text-text-2">
						No connectors yet. Add one above to share it across every project.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{connectors.map((c) => (
							<InstanceConnectorRow
								key={c.id}
								connector={c}
								scopeOptions={scopeOptions}
								focused={c.id === focus}
								focusRef={c.id === focus ? focusRef : undefined}
							/>
						))}
						<InfiniteScrollSentinel
							hasNextPage={hasNextPage}
							isFetchingNextPage={isFetchingNextPage}
							onLoadMore={fetchNextPage}
							testId="instance-connectors"
						/>
					</div>
				)}
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

interface InstanceConnectorRowProps {
	connector: Connector;
	scopeOptions: SearchableSelectOption[];
	focused: boolean;
	focusRef?: (el: HTMLDivElement | null) => void;
}

/** Pull a human message off either a thrown Error or the API client's ApiError. */
function errMessage(e: unknown, fallback: string): string {
	if (e instanceof Error) return e.message;
	if (e && typeof e === 'object' && 'message' in e) {
		const m = (e as { message: unknown }).message;
		if (typeof m === 'string' && m) return m;
	}
	return fallback;
}

function InstanceConnectorRow({
	connector,
	scopeOptions,
	focused,
	focusRef,
}: InstanceConnectorRowProps) {
	const deleteConnector = useDeleteInstanceConnector();
	const authStart = useInstanceAuthStart();
	const updateScope = useUpdateInstanceConnectorScope();
	const [rowError, setRowError] = useState<string | null>(null);
	const [rowInfo, setRowInfo] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const status = connectorStatus(connector);
	const credentials = connector.credentials ?? [];

	const url = typeof connector.config?.url === 'string' ? connector.config.url : '';
	const scopeLabel = connector.project_id ? (connector.project_name ?? 'Project') : 'All projects';
	const scopeValue = connector.project_id ?? ALL_PROJECTS;
	const scopeTone = connector.project_id
		? 'bg-info-soft text-info-soft-fg'
		: 'bg-neutral-soft text-neutral-soft-fg';

	const changeScope = (next: string) => {
		setRowError(null);
		const nextProjectId = next === ALL_PROJECTS ? null : next;
		// No-op when the picked scope already matches (avoids a needless 409-prone write).
		if (nextProjectId === (connector.project_id ?? null)) return;
		updateScope.mutate(
			{ id: connector.id, project_id: nextProjectId },
			{ onError: (e: unknown) => setRowError(errMessage(e, 'Failed to change scope')) },
		);
	};

	// Badge-styled trigger: clicking it opens the searchable scope picker.
	const scopeTrigger = (
		<button
			type="button"
			data-testid="instance-connector-scope"
			aria-label={`Scope: ${scopeLabel}. Change scope`}
			disabled={updateScope.isPending}
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full h-5 pl-2 pr-1.5 text-[11.5px] font-medium outline-none cursor-pointer transition-opacity hover:opacity-80 focus:ring-1 focus:ring-border-strong disabled:opacity-50 ${scopeTone}`}
		>
			{updateScope.isPending ? 'Saving…' : scopeLabel}
			<ChevronDown className="w-3 h-3 opacity-70" />
		</button>
	);

	const openConnect = () => {
		setRowError(null);
		setRowInfo(null);
		authStart.mutate(connector.id, {
			onSuccess: ({ auth_url }) => {
				if (!auth_url) {
					setRowInfo(
						"This MCP server doesn't advertise OAuth — authenticate with a header placeholder if needed.",
					);
					return;
				}
				const popupError = openAuthPopup(auth_url);
				if (popupError) setRowError(popupError);
			},
			onError: (e: unknown) =>
				setRowError(e instanceof Error ? e.message : 'Failed to start OAuth'),
		});
	};

	return (
		<div
			ref={focusRef}
			id={connector.id}
			className={`rounded-md border px-3 py-2 text-[13px] transition-colors ${
				focused ? 'border-info bg-info-soft' : 'border-border bg-surface'
			}`}
			data-testid="instance-connector-row"
			data-connector-id={connector.id}
			data-status={status}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{connector.display_name || connector.name}</span>
				<Badge color="neutral">{connector.kind}</Badge>
				<SearchableSelect
					options={scopeOptions}
					value={scopeValue}
					onChange={changeScope}
					trigger={scopeTrigger}
					searchPlaceholder="Search projects…"
					emptyLabel="No projects"
					testId="instance-connector-scope-select"
				/>
				{status === 'active' && <Badge color="success">Connected</Badge>}
				{status === 'failed' && <Badge color="danger">Failed</Badge>}
				{status === 'revoked' && <Badge>Revoked</Badge>}
				{connector.oauth_account_label && (
					<span className="text-xs text-text-2 font-mono" data-testid="connector-account">
						{connector.oauth_account_label}
					</span>
				)}
				<span className="text-xs text-text-3 font-mono truncate flex-1 min-w-0 basis-24">
					{url}
				</span>
				<div className="flex items-center gap-2 ml-auto shrink-0">
					{connector.kind === 'saas' && status !== 'active' && (
						<Button
							size="sm"
							variant="secondary"
							onClick={openConnect}
							disabled={authStart.isPending}
							data-testid="instance-connector-connect"
						>
							{authStart.isPending ? 'Starting…' : status === 'failed' ? 'Retry' : 'Connect'}
						</Button>
					)}
					<button
						type="button"
						onClick={() => setConfirmOpen(true)}
						aria-label="Remove"
						className="text-text-3 hover:text-danger"
					>
						<Trash2 className="w-3.5 h-3.5" />
					</button>
				</div>
			</div>
			{credentials.length > 0 && (
				<RelatedItemsList
					label="Credentials"
					testId={`connector-credentials-${connector.id}`}
					items={credentials.map((cred) => ({
						key: cred.id,
						label: cred.name,
						href: `/settings/credentials?focus=${cred.id}#${cred.id}`,
						testId: `connector-credential-link-${cred.id}`,
					}))}
				/>
			)}
			{connector.kind === 'saas' && status === 'active' && (
				<AdminMethodAccess connector={connector} />
			)}
			{/* Not gated on status === 'failed': a stale-token refresh failure is
			    recorded on a row that stays 'active', and would otherwise be invisible. */}
			{connector.auth_error && <p className="text-xs text-danger mt-1">{connector.auth_error}</p>}
			{rowError && <p className="text-xs text-danger mt-1">{rowError}</p>}
			{rowInfo && <p className="text-xs text-text-3 mt-1">{rowInfo}</p>}
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Remove connector?"
				description={
					<>
						Remove connector{' '}
						<span className="font-medium">{connector.display_name || connector.name}</span>? Its
						runs will lose access to this MCP server.
					</>
				}
				confirmLabel="Remove"
				variant="danger"
				onConfirm={async () => {
					await deleteConnector.mutateAsync(connector.id);
				}}
			/>
		</div>
	);
}

/**
 * Method access for a connector on the global page.
 *
 * This is the **only** place an "All projects" connector's allowlist can be
 * edited — such a connector is read-only from every project page, since it is
 * shared by all of them. The project page nests the same control inside its
 * card's Settings disclosure; this page's rows are flat, so it renders as one
 * line rather than behind another layer of expansion.
 */
function AdminMethodAccess({ connector }: { connector: Connector }) {
	const [open, setOpen] = useState(false);
	const methodsQuery = useConnectorMethods(null, connector.id);
	const refresh = useRefreshConnectorMethods(null);
	const [error, setError] = useState<string | null>(null);

	const summary = summarizeMethodAccess(
		methodsQuery.data?.methods ?? connector.discovered_methods ?? [],
		methodsQuery.data?.enabled_methods ?? connector.enabled_methods ?? null,
	);

	return (
		<div
			className="flex flex-wrap items-center gap-2 mt-1.5"
			data-testid={`connector-methods-row-${connector.id}`}
		>
			<span className="text-[11.5px] text-text-3">Methods</span>
			<Badge color={summary.mode === 'all' ? 'neutral' : 'info'}>
				{summary.mode === 'all'
					? summary.total > 0
						? `All ${summary.total}`
						: 'All'
					: `${summary.enabled} of ${summary.total}`}
			</Badge>
			{summary.total > 0 && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => setOpen(true)}
					data-testid="connector-methods-edit"
				>
					Edit
				</Button>
			)}
			<Button
				size="sm"
				variant="outline"
				disabled={refresh.isPending}
				data-testid="connector-methods-refresh"
				onClick={() => {
					setError(null);
					refresh.mutate(connector.id, {
						onError: (e: unknown) =>
							setError(errMessage(e, "Could not list this server's methods")),
					});
				}}
			>
				{refresh.isPending ? 'Listing…' : summary.total > 0 ? 'Refresh' : 'List methods'}
			</Button>
			{error && <span className="text-xs text-danger basis-full">{error}</span>}
			{open && methodsQuery.data && (
				<ConnectorMethodsDialog
					open={open}
					onOpenChange={setOpen}
					scope={null}
					connectorId={connector.id}
					connectorLabel={connector.display_name ?? connector.name}
					data={methodsQuery.data}
				/>
			)}
		</div>
	);
}

interface ConnectorsSearch {
	focus?: string;
}

export const Route = createFileRoute('/settings/connectors')({
	validateSearch: (search: Record<string, unknown>): ConnectorsSearch => ({
		focus: typeof search.focus === 'string' ? search.focus : undefined,
	}),
	component: InstanceConnectorsPage,
});

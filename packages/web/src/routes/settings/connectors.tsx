import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	INSTANCE_CONNECTORS_KEY,
	useCreateInstanceConnector,
	useDeleteInstanceConnector,
	useInstanceAuthStart,
	useInstanceConnectors,
} from '../../hooks/use-instance-connectors';
import { connectorStatus, type McpConnection } from '../../hooks/use-mcp-connections';
import { useMe } from '../../hooks/use-me';

function openAuthPopup(authUrl: string): string | null {
	const popup = window.open(authUrl, 'hezo-connect', 'width=600,height=720');
	return popup ? null : 'Pop-up blocked. Allow pop-ups for Hezo and try again.';
}

function InstanceConnectorsPage() {
	const { data: me } = useMe();
	const { focus } = Route.useSearch();
	const { data: connectors = [] } = useInstanceConnectors();
	const createConnector = useCreateInstanceConnector();
	const authStart = useInstanceAuthStart();
	const queryClient = useQueryClient();

	// Ref callback fires when the focused row mounts (which can happen after the
	// initial render once the connectors query resolves). Scrolls into view then.
	const focusRef = useCallback((el: HTMLDivElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [displayName, setDisplayName] = useState('');
	const [url, setUrl] = useState('');
	const [error, setError] = useState<string | null>(null);

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
		let created: McpConnection;
		try {
			created = await createConnector.mutateAsync({
				name: name.trim(),
				display_name: displayName.trim() || undefined,
				kind: 'saas',
				config: { url: url.trim() },
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create connector');
			return;
		}
		setName('');
		setDisplayName('');
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
								content="Remote MCP servers shared with every team's agent runs."
								data-testid="connectors-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							Remote (SaaS) MCP servers shared with every team's agent runs. Servers that advertise
							OAuth get a connect popup when added; for the rest, authenticate headers with a shared
							credential placeholder (<span className="font-mono">__HEZO_SECRET_NAME__</span>).
						</p>
					</div>
					<Button variant="secondary" size="sm" onClick={() => setShowForm((s) => !s)}>
						<Plus className="w-3 h-3" /> Add
					</Button>
				</div>

				{showForm && (
					<form onSubmit={handleCreate} className="flex flex-col gap-2 mb-4">
						<div className="flex flex-col sm:flex-row gap-2">
							<Input
								placeholder="Name (e.g. shared-docs)"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								className="flex-1"
							/>
							<Input
								placeholder="Display name (optional)"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								className="flex-1"
							/>
						</div>
						<Input
							placeholder="MCP server URL (e.g. https://mcp.example.com/mcp)"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							required
						/>
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={createConnector.isPending}>
								Add connector
							</Button>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => {
									setShowForm(false);
									setError(null);
								}}
							>
								Cancel
							</Button>
						</div>
					</form>
				)}

				{/* Rendered outside the form: the OAuth kickoff runs after the form
				    closes, so popup-blocked / auth-start errors need a home too. */}
				{error && <p className="text-[13px] text-danger mb-4">{error}</p>}

				{!connectors.length ? (
					<p className="text-[13px] text-text-2">
						No instance connectors yet. Add one above to share it across every team.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{connectors.map((c) => (
							<InstanceConnectorRow
								key={c.id}
								connector={c}
								focused={c.id === focus}
								focusRef={c.id === focus ? focusRef : undefined}
							/>
						))}
					</div>
				)}
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

interface InstanceConnectorRowProps {
	connector: McpConnection;
	focused: boolean;
	focusRef?: (el: HTMLDivElement | null) => void;
}

function InstanceConnectorRow({ connector, focused, focusRef }: InstanceConnectorRowProps) {
	const deleteConnector = useDeleteInstanceConnector();
	const authStart = useInstanceAuthStart();
	const [rowError, setRowError] = useState<string | null>(null);
	const [rowInfo, setRowInfo] = useState<string | null>(null);
	const status = connectorStatus(connector);

	const url = typeof connector.config?.url === 'string' ? connector.config.url : '';

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
				{status === 'active' && <Badge color="success">Connected</Badge>}
				{status === 'failed' && <Badge color="danger">Failed</Badge>}
				{status === 'revoked' && <Badge>Revoked</Badge>}
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
						onClick={() => {
							if (
								confirm(`Remove instance connector "${connector.display_name || connector.name}"?`)
							) {
								deleteConnector.mutate(connector.id);
							}
						}}
						aria-label="Remove"
						className="text-text-3 hover:text-danger"
					>
						<Trash2 className="w-3.5 h-3.5" />
					</button>
				</div>
			</div>
			{connector.auth_error && status === 'failed' && (
				<p className="text-xs text-danger mt-1">{connector.auth_error}</p>
			)}
			{rowError && <p className="text-xs text-danger mt-1">{rowError}</p>}
			{rowInfo && <p className="text-xs text-text-3 mt-1">{rowInfo}</p>}
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

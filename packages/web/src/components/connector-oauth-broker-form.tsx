import {
	ArrowUpRight,
	Check,
	Copy,
	ExternalLink,
	Info,
	KeyRound,
	Loader2,
	Lock,
	ShieldCheck,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
	type DeviceFlowStart,
	type DeviceFlowSuccess,
	type OAuthProviderDescriptor,
	pollBrokerDeviceFlow,
	useBrokerDeviceStart,
	useOAuthProviders,
} from '../hooks/use-oauth-connections';
import { copyToClipboard } from '../lib/clipboard';
import { Button } from './ui/button';

const CUSTOM = '__custom__';

/** Live docs section explaining the OAuth device flow end-to-end. */
export const DOCS_DEVICE_FLOW_URL =
	'https://hezo.ai/docs/mcp/connecting-mcp-servers#connecting-an-oauth-api-with-the-device-flow-no-callback';

const inputClass =
	'w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm text-text-1 focus:border-border-strong focus:outline-none';

/**
 * Per-provider setup guidance: where the operator creates the OAuth client and
 * which client type to pick. Keyed by the bundled provider id. Providers without
 * an entry fall back to generic, descriptor-derived copy.
 */
interface ProviderGuide {
	consoleUrl: string;
	consoleLabel: string;
	clientType?: string;
	steps: string[];
	secret: 'required' | 'optional' | 'none';
}

const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
	'google-youtube': {
		consoleUrl: 'https://console.cloud.google.com/apis/credentials',
		consoleLabel: 'Google Cloud Console → Credentials',
		clientType: 'TVs and Limited Input devices',
		secret: 'required',
		steps: [
			'Pick (or create) a project in the Google Cloud Console and enable the YouTube Data API v3.',
			'Configure the OAuth consent screen, adding your Google account under Test users.',
			'Create credentials → OAuth client ID, and choose the “TVs and Limited Input devices” application type.',
			'Copy the generated Client ID and Client secret into the fields below.',
		],
	},
	github: {
		consoleUrl: 'https://github.com/settings/developers',
		consoleLabel: 'GitHub → Developer settings → OAuth Apps',
		clientType: 'OAuth App with Device Flow enabled',
		secret: 'none',
		steps: [
			'Register a New OAuth App under GitHub Developer settings.',
			'Enable “Device Flow” in the app’s settings and save.',
			'Copy the app’s Client ID below — the device flow needs no client secret.',
		],
	},
};

export interface ConnectorOAuthBrokerFormProps {
	projectId: string;
	connectorId: string;
	/** Connector display name used in the copy. */
	connectorLabel: string;
	/**
	 * When set, the provider is fixed (the agent pre-selected it): the dropdown is
	 * hidden and shown as a read-only "set by agent" row. When omitted, the user
	 * picks a bundled provider or Custom… (the manual fallback).
	 */
	lockedProviderId?: string | null;
	/** `dialog` tightens spacing for a modal; `inline` is the default in-page form. */
	layout?: 'inline' | 'dialog';
	onSuccess?: (connection: DeviceFlowSuccess['connection']) => void;
	onCancel?: () => void;
}

/**
 * The OAuth device-flow (RFC 8628) broker form, with no dialog chrome so it can
 * render inline (in a task comment or a Connectors-page row) or inside a dialog.
 * Step 1 collects the client id (+ optional secret) and either a bundled provider
 * or custom endpoints; step 2 shows the device code and polls until the user
 * authorizes. The refresh token + client secret stay host-side and never enter a
 * run; only the short-lived access token is later surfaced.
 */
export function ConnectorOAuthBrokerForm({
	projectId,
	connectorId,
	connectorLabel,
	lockedProviderId,
	layout = 'inline',
	onSuccess,
	onCancel,
}: ConnectorOAuthBrokerFormProps) {
	const { data: providers = [] } = useOAuthProviders();
	const brokerStart = useBrokerDeviceStart(projectId);

	const [providerId, setProviderId] = useState(lockedProviderId ?? '');
	const [clientId, setClientId] = useState('');
	const [clientSecret, setClientSecret] = useState('');
	const [deviceCodeUrl, setDeviceCodeUrl] = useState('');
	const [tokenUrl, setTokenUrl] = useState('');
	const [scopesCsv, setScopesCsv] = useState('');
	const [allowedHostsCsv, setAllowedHostsCsv] = useState('');

	const [deviceFlow, setDeviceFlow] = useState<DeviceFlowStart | null>(null);
	const [statusMessage, setStatusMessage] = useState('');
	const [errorMessage, setErrorMessage] = useState('');
	const [codeCopied, setCodeCopied] = useState(false);
	const stopRef = useRef(false);

	const onSuccessRef = useRef(onSuccess);
	onSuccessRef.current = onSuccess;

	const isLocked = !!lockedProviderId;
	const isCustom = providerId === CUSTOM;
	const selectedProvider: OAuthProviderDescriptor | undefined = providers.find(
		(p) => p.id === providerId,
	);
	const guide = PROVIDER_GUIDES[providerId];

	// Poll loop once a device flow is started.
	useEffect(() => {
		if (!deviceFlow) return;
		stopRef.current = false;
		setStatusMessage('Waiting for you to authorize…');

		(async () => {
			while (!stopRef.current) {
				try {
					const result = await pollBrokerDeviceFlow(projectId, connectorId, deviceFlow.flow_id);
					if (result.status === 'success') {
						setStatusMessage(`Connected ${result.connection.provider_account_label}.`);
						onSuccessRef.current?.(result.connection);
						setDeviceFlow(null);
						return;
					}
					await new Promise((r) =>
						setTimeout(r, Math.max(2000, (result.retry_after ?? deviceFlow.interval) * 1000)),
					);
				} catch (e) {
					setErrorMessage((e as Error).message);
					setStatusMessage('');
					setDeviceFlow(null);
					return;
				}
			}
		})();

		return () => {
			stopRef.current = true;
		};
	}, [deviceFlow, projectId, connectorId]);

	const csvToList = (csv: string): string[] =>
		csv
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setErrorMessage('');
		const cid = clientId.trim();
		if (!cid) {
			setErrorMessage('Enter the OAuth client ID.');
			return;
		}
		if (isCustom && (!deviceCodeUrl.trim() || !tokenUrl.trim())) {
			setErrorMessage('Custom provider needs a device code URL and a token URL.');
			return;
		}
		setStatusMessage('Requesting a device code…');
		brokerStart.mutate(
			{
				connectorId,
				provider_id: isCustom || !providerId ? undefined : providerId,
				client_id: cid,
				client_secret: clientSecret.trim() || undefined,
				device_code_url: isCustom ? deviceCodeUrl.trim() : undefined,
				token_url: isCustom ? tokenUrl.trim() : undefined,
				scopes: isCustom && scopesCsv.trim() ? csvToList(scopesCsv) : undefined,
				allowed_hosts: isCustom && allowedHostsCsv.trim() ? csvToList(allowedHostsCsv) : undefined,
			},
			{
				onSuccess: (flow) => {
					setDeviceFlow(flow);
					try {
						window.open(flow.verification_uri, '_blank', 'noopener');
					} catch {
						/* pop-up blocked — user can copy verification_uri */
					}
				},
				onError: (err: unknown) => {
					setErrorMessage(err instanceof Error ? err.message : 'Failed to start the device flow');
					setStatusMessage('');
				},
			},
		);
	};

	const handleCopyCode = async () => {
		if (!deviceFlow) return;
		if (await copyToClipboard(deviceFlow.user_code)) {
			setCodeCopied(true);
			setTimeout(() => setCodeCopied(false), 2000);
		}
	};

	const secretLabel =
		guide?.secret === 'none'
			? 'Client secret (not needed)'
			: guide?.secret === 'required'
				? 'Client secret'
				: 'Client secret (optional)';
	const secretHint =
		guide?.secret === 'none'
			? 'This provider’s device flow doesn’t use a client secret — leave this blank.'
			: guide?.secret === 'required'
				? 'Paste the client secret shown next to the client ID in the console.'
				: 'Only needed if your provider issues a secret for its device-flow client.';

	if (deviceFlow) {
		return (
			<div className={layout === 'dialog' ? 'space-y-4' : 'space-y-3'}>
				<p className="text-sm text-text-2">
					Open{' '}
					<a
						href={deviceFlow.verification_uri}
						target="_blank"
						rel="noopener"
						className="text-accent underline inline-flex items-center gap-1"
					>
						{deviceFlow.verification_uri}
						<ExternalLink className="size-3" />
					</a>{' '}
					(it should have opened automatically) and enter this code:
				</p>
				<div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-2/60 px-4 py-3">
					<div
						className="font-mono text-2xl tracking-widest text-text-1 select-all"
						data-testid="broker-device-code"
					>
						{deviceFlow.user_code}
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={handleCopyCode}
						aria-label="Copy device code"
					>
						{codeCopied ? (
							<>
								<Check className="size-4 mr-1.5" />
								Copied
							</>
						) : (
							<>
								<Copy className="size-4 mr-1.5" />
								Copy
							</>
						)}
					</Button>
				</div>
				<p className="text-xs text-text-3 flex items-center gap-2">
					<Loader2 className="size-3.5 animate-spin" />
					{statusMessage}
				</p>
				<p className="text-xs text-text-3">
					Keep this open — it finishes as soon as you approve. The code expires in a few minutes; if
					it lapses, cancel and start again.
				</p>
				{onCancel && (
					<div className="flex justify-end">
						<Button variant="secondary" size="sm" onClick={onCancel}>
							Cancel
						</Button>
					</div>
				)}
			</div>
		);
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-4" data-testid="broker-form">
			{errorMessage && (
				<div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
					{errorMessage}
				</div>
			)}

			{/* How the device flow works — three plain steps. */}
			<div className="rounded-md border border-info-soft/60 bg-info-soft/40 px-3 py-2.5">
				<div className="flex items-center gap-1.5 text-xs font-medium text-info-soft-fg mb-1.5">
					<Info className="size-3.5" />
					How this works
				</div>
				<ol className="list-decimal ml-4 space-y-1 text-xs text-text-2 marker:text-text-3">
					<li>Paste an OAuth client ID for {connectorLabel}.</li>
					<li>Hezo shows a short code and a link — open it on any device and approve.</li>
					<li>
						Hezo keeps the tokens fresh and hands your agents a placeholder, never the real token.
					</li>
				</ol>
			</div>

			{isLocked ? (
				<div className="flex items-center gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2 text-sm">
					<Lock className="size-3.5 text-text-3" />
					<span className="text-text-2">Provider</span>
					<span className="font-medium text-text-1" data-testid="broker-locked-provider">
						{providerId}
					</span>
					<span className="ml-auto text-xs text-text-3">set by agent</span>
				</div>
			) : (
				<label className="flex flex-col gap-1 text-xs font-medium text-text-2">
					Provider
					<select
						value={providerId}
						onChange={(e) => setProviderId(e.target.value)}
						className={inputClass}
						data-testid="broker-provider-select"
					>
						<option value="">Select a provider…</option>
						{providers.map((p) => (
							<option key={p.id} value={p.id}>
								{p.id}
							</option>
						))}
						<option value={CUSTOM}>Custom…</option>
					</select>
					{!providerId && (
						<span className="font-normal text-text-3">
							Bundled providers come with the right endpoints and scopes pre-filled. Choose{' '}
							<strong className="font-medium">Custom…</strong> for anything else.
						</span>
					)}
				</label>
			)}

			{/* Provider-specific "where to get these values" guidance. */}
			{guide && (
				<div className="rounded-md border border-border bg-surface-2/60 px-3 py-2.5">
					<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
						<span className="text-xs font-medium text-text-1">Where to get these values</span>
						{guide.clientType && (
							<span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-2">
								Client type: {guide.clientType}
							</span>
						)}
					</div>
					<ol className="list-decimal ml-4 space-y-1 text-xs text-text-2 marker:text-text-3">
						{guide.steps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
					<a
						href={guide.consoleUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
					>
						Open {guide.consoleLabel}
						<ExternalLink className="size-3" />
					</a>
				</div>
			)}

			{isCustom && (
				<div className="rounded-md border border-border bg-surface-2/60 px-3 py-2.5">
					<div className="flex items-center gap-1.5 text-xs font-medium text-text-1 mb-2">
						<KeyRound className="size-3.5" />
						Custom provider endpoints
					</div>
					<p className="text-xs text-text-3 mb-2.5">
						Register an OAuth client that supports the device authorization grant (RFC 8628), then
						paste its endpoints, scopes, and the hosts the token may be sent to.
					</p>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
						<label className="flex flex-col gap-1 text-xs text-text-2">
							Device code URL
							<input
								value={deviceCodeUrl}
								onChange={(e) => setDeviceCodeUrl(e.target.value)}
								placeholder="https://…/device/code"
								className={`${inputClass} font-mono`}
								data-testid="broker-device-code-url"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs text-text-2">
							Token URL
							<input
								value={tokenUrl}
								onChange={(e) => setTokenUrl(e.target.value)}
								placeholder="https://…/token"
								className={`${inputClass} font-mono`}
								data-testid="broker-token-url"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs text-text-2">
							Scopes (comma-separated)
							<input
								value={scopesCsv}
								onChange={(e) => setScopesCsv(e.target.value)}
								placeholder="scope.a, scope.b"
								className={`${inputClass} font-mono`}
								data-testid="broker-scopes"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs text-text-2">
							Allowed hosts (comma-separated)
							<input
								value={allowedHostsCsv}
								onChange={(e) => setAllowedHostsCsv(e.target.value)}
								placeholder="api.example.com"
								className={`${inputClass} font-mono`}
								data-testid="broker-allowed-hosts"
							/>
						</label>
					</div>
				</div>
			)}

			{/* What the connection will be able to do, from the bundled descriptor. */}
			{selectedProvider &&
				(selectedProvider.scopes.length > 0 || selectedProvider.allowed_hosts.length > 0) && (
					<div className="text-xs text-text-3 space-y-1.5">
						{selectedProvider.scopes.length > 0 && (
							<div>
								<span className="font-medium text-text-2">Scopes granted:</span>{' '}
								<span className="font-mono break-all">{selectedProvider.scopes.join(', ')}</span>
							</div>
						)}
						{selectedProvider.allowed_hosts.length > 0 && (
							<div>
								<span className="font-medium text-text-2">Token sent only to:</span>{' '}
								<span className="font-mono break-all">
									{selectedProvider.allowed_hosts.join(', ')}
								</span>
							</div>
						)}
					</div>
				)}

			<div className="flex flex-col gap-3">
				<label className="flex flex-col gap-1 text-xs font-medium text-text-2">
					Client ID
					<input
						value={clientId}
						onChange={(e) => setClientId(e.target.value)}
						placeholder="OAuth client ID"
						className={`${inputClass} font-mono`}
						data-testid="broker-client-id"
					/>
					<span className="font-normal text-text-3">
						The public identifier for the OAuth client you created above.
					</span>
				</label>
				<label className="flex flex-col gap-1 text-xs font-medium text-text-2">
					{secretLabel}
					<input
						type="password"
						autoComplete="off"
						value={clientSecret}
						onChange={(e) => setClientSecret(e.target.value)}
						placeholder="OAuth client secret"
						className={`${inputClass} font-mono`}
						data-testid="broker-client-secret"
					/>
					<span className="font-normal text-text-3">{secretHint}</span>
				</label>
			</div>

			<div className="flex items-start gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2.5 text-xs text-text-2">
				<ShieldCheck className="size-4 shrink-0 text-info mt-0.5" />
				<span>
					The client secret and refresh token are stored encrypted in the Hezo vault and never enter
					an agent run. Only the short-lived access token is exposed to agents — as a placeholder
					the egress proxy fills in — and Hezo refreshes it automatically.
				</span>
			</div>

			<a
				href={DOCS_DEVICE_FLOW_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1 text-xs text-text-3 hover:text-text-1"
			>
				Learn more about the OAuth device flow
				<ArrowUpRight className="size-3" />
			</a>

			<div className="flex items-center justify-end gap-2">
				{onCancel && (
					<Button type="button" variant="secondary" size="sm" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button
					type="submit"
					size="sm"
					disabled={brokerStart.isPending}
					data-testid="broker-submit"
				>
					{brokerStart.isPending ? 'Starting…' : 'Start device flow'}
				</Button>
			</div>
		</form>
	);
}

import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, ExternalLink, Loader2, Plug } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
	type DeviceFlowStart,
	type DeviceFlowSuccess,
	pollBrokerDeviceFlow,
	useBrokerDeviceStart,
	useOAuthProviders,
} from '../hooks/use-oauth-connections';
import { copyToClipboard } from '../lib/clipboard';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';

interface ConnectorOAuthBrokerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	connectorId: string;
	/** Connector display name used in the dialog copy. */
	connectorLabel: string;
	onSuccess?: (connection: DeviceFlowSuccess['connection']) => void;
}

const CUSTOM = '__custom__';

const inputClass =
	'w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm text-text-1';

/**
 * Connect an OAuth-backed provider (Google/YouTube, …) to an `api` connector via
 * the OAuth 2.0 device flow (RFC 8628) — no browser callback, so it works on any
 * instance URL. Step 1 collects the client id (+ optional secret) and either a
 * bundled provider or custom endpoints; step 2 shows the device code and polls
 * until the user authorizes. The refresh token + client secret stay host-side and
 * never enter a run; only the short-lived access token is later surfaced.
 */
export function ConnectorOAuthBrokerDialog({
	open,
	onOpenChange,
	projectId,
	connectorId,
	connectorLabel,
	onSuccess,
}: ConnectorOAuthBrokerDialogProps) {
	const { data: providers = [] } = useOAuthProviders();
	const brokerStart = useBrokerDeviceStart(projectId);

	const [providerId, setProviderId] = useState('');
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

	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const onSuccessRef = useRef(onSuccess);
	onSuccessRef.current = onSuccess;

	const isCustom = providerId === CUSTOM;

	// Reset all state whenever the dialog closes so a reopen starts clean.
	useEffect(() => {
		if (open) return;
		stopRef.current = true;
		setProviderId('');
		setClientId('');
		setClientSecret('');
		setDeviceCodeUrl('');
		setTokenUrl('');
		setScopesCsv('');
		setAllowedHostsCsv('');
		setDeviceFlow(null);
		setStatusMessage('');
		setErrorMessage('');
		setCodeCopied(false);
	}, [open]);

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
						onOpenChangeRef.current(false);
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

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md" data-testid="connector-oauth-broker-dialog">
				<Dialog.Title className="text-base font-semibold mb-1 pr-8 flex items-center gap-2">
					<Plug className="size-4" />
					Connect OAuth — {connectorLabel}
				</Dialog.Title>
				<Dialog.Description className="text-sm text-text-2 mb-4">
					Connect an OAuth-backed API to this connector via the device flow. No browser callback is
					needed.
				</Dialog.Description>

				{errorMessage && (
					<div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger mb-4">
						{errorMessage}
					</div>
				)}

				{!deviceFlow ? (
					<form onSubmit={submit} className="flex flex-col gap-3" data-testid="broker-form">
						<label className="flex flex-col gap-1 text-xs text-text-2">
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
						</label>

						{isCustom && (
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
						)}

						<label className="flex flex-col gap-1 text-xs text-text-2">
							Client ID
							<input
								value={clientId}
								onChange={(e) => setClientId(e.target.value)}
								placeholder="OAuth client ID"
								className={`${inputClass} font-mono`}
								data-testid="broker-client-id"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs text-text-2">
							Client secret (optional)
							<input
								type="password"
								autoComplete="off"
								value={clientSecret}
								onChange={(e) => setClientSecret(e.target.value)}
								placeholder="OAuth client secret"
								className={`${inputClass} font-mono`}
								data-testid="broker-client-secret"
							/>
						</label>
						<p className="text-xs text-text-3">
							The client secret and the refresh token are stored host-side in the Hezo vault and
							never enter an agent run. Only the short-lived access token is exposed, kept fresh
							automatically.
						</p>

						<div className="flex items-center justify-end gap-2 mt-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
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
				) : (
					<div className="space-y-3">
						<p className="text-sm">
							Open{' '}
							<a
								href={deviceFlow.verification_uri}
								target="_blank"
								rel="noopener"
								className="underline inline-flex items-center gap-1"
							>
								{deviceFlow.verification_uri}
								<ExternalLink className="size-3" />
							</a>{' '}
							and enter this code:
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<div
								className="font-mono text-2xl tracking-widest select-all"
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
						<div className="flex justify-end">
							<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog.Root>
	);
}

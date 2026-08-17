import { getConnectorCapability } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plug } from 'lucide-react';
import { useState } from 'react';
import type { Connector } from '../hooks/use-connectors';
import { useAuthStart } from '../hooks/use-oauth-connections';
import { useOAuthSuccessRefetch } from '../hooks/use-oauth-success';
import { queryKeys } from '../lib/query-keys';
import { apiKeyGuideFor, ConnectorApiKeyForm } from './connector-api-key-form';
import { ConnectorDeviceFlowDialog } from './connector-device-flow-dialog';
import { ConnectorOAuthBrokerForm } from './connector-oauth-broker-form';
import { Button } from './ui/button';

interface Props {
	connector: Connector;
	/** Route-param slug — used for query keys and API calls (never a resolved UUID). */
	projectId: string;
	variant: 'comment' | 'page';
	/** Start with the OAuth broker form already expanded (defaults to the comment surface). */
	defaultBrokerOpen?: boolean;
	onDone?: () => void;
}

/**
 * The shared "finish connecting this connector" UI, used both inline in a task
 * comment (`connect_required`) and expanded on the Connectors page. It selects the
 * right flow from the connector's kind + capability + the agent-preset broker
 * provider, and composes the existing pieces: the redirect popup (`useAuthStart`),
 * the device-code dialog, the OAuth device+client-id broker form, and the API-key
 * form. Never optimistic — completion is response-driven and refetches the row.
 */
export function ConnectorCompletion({
	connector,
	projectId,
	variant,
	defaultBrokerOpen,
	onDone,
}: Props) {
	const queryClient = useQueryClient();
	const authStart = useAuthStart(projectId);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [deviceOpen, setDeviceOpen] = useState(false);
	const [showApiKey, setShowApiKey] = useState(false);
	const [brokerOpen, setBrokerOpen] = useState(defaultBrokerOpen ?? variant === 'comment');

	const capability = getConnectorCapability(connector.name);
	const usesDeviceFlow = !!capability?.deviceAuth;
	const isApi = connector.kind === 'api';
	const cfg = (connector.config ?? {}) as {
		oauth_provider_id?: unknown;
		auth?: { placement?: unknown };
	};
	const lockedProviderId =
		typeof cfg.oauth_provider_id === 'string' && cfg.oauth_provider_id
			? cfg.oauth_provider_id
			: undefined;
	// A query-string credential is never an OAuth access token (those ride a Bearer
	// header), so a query-placement `api` connector is unambiguously a static-key
	// REST API — lead with the API-key form, not the OAuth broker.
	const isStaticKeyApi = isApi && cfg.auth?.placement === 'query';
	const apiKeyGuide = apiKeyGuideFor(connector.config);
	const label = connector.display_name ?? capability?.displayName ?? connector.name;

	const apiKeyTestId =
		variant === 'comment' ? 'connect-required-api-key-toggle' : 'connector-api-key-toggle';
	const connectTestId = variant === 'comment' ? 'connect-button' : 'connector-connect';

	const invalidate = () => {
		// The `projects.connectors` prefix (length 3) also covers connectorDetail /
		// connectorsFiltered, so both the page list and the comment's single-row
		// query refetch. (Must NOT be `teams.connectors`, which no query reads.)
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		onDone?.();
	};

	// Refetch immediately when the OAuth popup signals success, without waiting
	// for the WebSocket round-trip.
	useOAuthSuccessRefetch(queryKeys.projects.connectors(projectId));

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
				if (!auth_url) {
					setInfo("This MCP server doesn't advertise OAuth - use the API key option below.");
					return;
				}
				const popup = window.open(auth_url, 'hezo-connect', 'width=600,height=720');
				if (!popup) {
					setError('Pop-up blocked. Allow pop-ups for Hezo and try again.');
				}
			},
			onError: (e: unknown) => {
				setError(e instanceof Error ? e.message : 'Failed to start OAuth flow');
			},
		});
	};

	const apiKeyToggle = (
		<Button
			size="sm"
			variant="outline"
			onClick={() => setShowApiKey((v) => !v)}
			data-testid={apiKeyTestId}
		>
			<KeyRound className="size-3.5 mr-1" />
			{variant === 'comment' ? 'Use API key' : 'API key'}
		</Button>
	);

	const apiKeyForm = showApiKey && (
		<ConnectorApiKeyForm
			projectId={projectId}
			connectorId={connector.id}
			guide={apiKeyGuide}
			onSuccess={() => {
				setShowApiKey(false);
				invalidate();
			}}
			onCancel={() => setShowApiKey(false)}
		/>
	);

	return (
		<div className="flex flex-col gap-2">
			{error && <p className="text-xs text-danger-soft-fg">{error}</p>}
			{info && <p className="text-xs text-text-2">{info}</p>}

			{isStaticKeyApi ? (
				<ConnectorApiKeyForm
					projectId={projectId}
					connectorId={connector.id}
					guide={apiKeyGuide}
					onSuccess={invalidate}
				/>
			) : isApi && brokerOpen ? (
				<>
					<ConnectorOAuthBrokerForm
						projectId={projectId}
						connectorId={connector.id}
						connectorLabel={label}
						lockedProviderId={lockedProviderId}
						layout="inline"
						onSuccess={invalidate}
						onCancel={variant === 'page' ? () => setBrokerOpen(false) : undefined}
					/>
					<div className="flex items-center gap-2">{apiKeyToggle}</div>
					{apiKeyForm}
				</>
			) : (
				<>
					<div className="flex items-center gap-2 flex-wrap">
						{isApi ? (
							<Button
								size="sm"
								onClick={() => setBrokerOpen(true)}
								data-testid="connector-oauth-broker"
							>
								<Plug className="size-3.5 mr-1" />
								Complete connection
							</Button>
						) : (
							<Button
								size="sm"
								onClick={openConnect}
								disabled={authStart.isPending}
								data-testid={connectTestId}
							>
								{authStart.isPending ? 'Starting…' : 'Connect'}
							</Button>
						)}
						{apiKeyToggle}
					</div>
					{apiKeyForm}
				</>
			)}

			{usesDeviceFlow && deviceOpen && (
				<ConnectorDeviceFlowDialog
					open={deviceOpen}
					onOpenChange={setDeviceOpen}
					projectId={projectId}
					connectorId={connector.id}
					providerLabel={label}
					onSuccess={invalidate}
				/>
			)}
		</div>
	);
}

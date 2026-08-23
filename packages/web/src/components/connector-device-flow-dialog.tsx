import * as Dialog from '@radix-ui/react-dialog';
import { Plug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
	type DeviceFlowStart,
	type DeviceFlowSuccess,
	pollDeviceFlow,
	useDeviceStart,
} from '../hooks/use-oauth-connections';
import { useI18n } from '../lib/i18n';
import { type DeviceCodeState, DeviceCodeSteps } from './ui/device-code-steps';
import { DialogContent } from './ui/dialog';

interface ConnectorDeviceFlowDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	connectorId: string;
	/** Provider display name used in the dialog copy (e.g. "GitHub"). */
	providerLabel: string;
	onSuccess?: (connection: DeviceFlowSuccess['connection']) => void;
}

/**
 * Drives the OAuth device flow (RFC 8628) for a connector: requests a device
 * code, then polls until the user authorizes. Provider-agnostic — works for any
 * connector whose capability declares `deviceAuth`.
 *
 * Transport only. The code, the link and the sequence between them are
 * `DeviceCodeSteps`, shared with the AI-provider subscription sign-in.
 */
export function ConnectorDeviceFlowDialog({
	open,
	onOpenChange,
	projectId,
	connectorId,
	providerLabel,
	onSuccess,
}: ConnectorDeviceFlowDialogProps) {
	const { t } = useI18n();
	const startDeviceFlow = useDeviceStart(projectId);
	const [deviceFlow, setDeviceFlow] = useState<DeviceFlowStart | null>(null);
	const [errorMessage, setErrorMessage] = useState('');
	const [attempt, setAttempt] = useState(0);
	const stopRef = useRef(false);
	const startedRef = useRef(false);

	const startDeviceFlowRef = useRef(startDeviceFlow);
	startDeviceFlowRef.current = startDeviceFlow;
	const connectorIdRef = useRef(connectorId);
	connectorIdRef.current = connectorId;
	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const onSuccessRef = useRef(onSuccess);
	onSuccessRef.current = onSuccess;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger - bumping it is what restarts a flow the dialog never closed
	useEffect(() => {
		if (!open) {
			startedRef.current = false;
			stopRef.current = true;
			setDeviceFlow(null);
			setErrorMessage('');
			return;
		}
		if (startedRef.current) return;
		startedRef.current = true;

		startDeviceFlowRef.current
			.mutateAsync(connectorIdRef.current)
			.then(setDeviceFlow)
			.catch((e: Error) => setErrorMessage(e.message));
	}, [open, attempt]);

	useEffect(() => {
		if (!deviceFlow) return;
		stopRef.current = false;

		(async () => {
			while (!stopRef.current) {
				try {
					const result = await pollDeviceFlow(projectId, connectorId, deviceFlow.flow_id);
					if (result.status === 'success') {
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
					setDeviceFlow(null);
					return;
				}
			}
		})();

		return () => {
			stopRef.current = true;
		};
	}, [deviceFlow, projectId, connectorId]);

	// `expires_in` is a duration the server measured at issue time; the countdown
	// wants a deadline, so pin one the moment the code lands.
	const expiresAt = deviceFlow
		? new Date(Date.now() + deviceFlow.expires_in * 1000).toISOString()
		: null;

	const state: DeviceCodeState = errorMessage
		? { status: 'failed', title: errorMessage }
		: deviceFlow
			? {
					status: 'awaiting',
					url: deviceFlow.verification_uri,
					userCode: deviceFlow.user_code,
					expiresAt,
				}
			: { status: 'starting' };

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			{/* The steps carry their own heading and subtitle, so the dialog names
			    itself for assistive tech and opts out of a second description. */}
			<DialogContent
				size="md"
				aria-describedby={undefined}
				data-testid="connector-device-flow-dialog"
			>
				<Dialog.Title className="sr-only">
					{t('deviceSignIn.connectTitle', { provider: providerLabel })}
				</Dialog.Title>
				<DeviceCodeSteps
					testId="connector-device-flow-steps"
					title={t('deviceSignIn.connectTitle', { provider: providerLabel })}
					providerLabel={providerLabel}
					icon={<Plug className="size-4" />}
					state={state}
					onRetry={() => {
						setErrorMessage('');
						startedRef.current = false;
						setAttempt((n) => n + 1);
					}}
					onCancel={() => onOpenChange(false)}
				/>
			</DialogContent>
		</Dialog.Root>
	);
}

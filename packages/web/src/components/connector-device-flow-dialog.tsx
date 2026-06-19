import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, ExternalLink, Loader2, Plug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
	type DeviceFlowStart,
	type DeviceFlowSuccess,
	pollDeviceFlow,
	useDeviceStart,
} from '../hooks/use-oauth-connections';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';

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
 * code, shows the user code + verification URL, then polls until the user
 * authorizes. Provider-agnostic — works for any connector whose capability
 * declares `deviceAuth`.
 */
export function ConnectorDeviceFlowDialog({
	open,
	onOpenChange,
	projectId,
	connectorId,
	providerLabel,
	onSuccess,
}: ConnectorDeviceFlowDialogProps) {
	const startDeviceFlow = useDeviceStart(projectId);
	const [deviceFlow, setDeviceFlow] = useState<DeviceFlowStart | null>(null);
	const [statusMessage, setStatusMessage] = useState('');
	const [errorMessage, setErrorMessage] = useState('');
	const [codeCopied, setCodeCopied] = useState(false);
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

	useEffect(() => {
		if (!open) {
			startedRef.current = false;
			stopRef.current = true;
			setDeviceFlow(null);
			setStatusMessage('');
			setErrorMessage('');
			setCodeCopied(false);
			return;
		}
		if (startedRef.current) return;
		startedRef.current = true;

		setStatusMessage('Requesting a device code…');
		startDeviceFlowRef.current
			.mutateAsync(connectorIdRef.current)
			.then((flow) => {
				setDeviceFlow(flow);
				try {
					window.open(flow.verification_uri, '_blank', 'noopener');
				} catch {
					/* pop-up blocked — user can copy verification_uri */
				}
			})
			.catch((e: Error) => {
				setErrorMessage(e.message);
				setStatusMessage('');
			});
	}, [open]);

	useEffect(() => {
		if (!deviceFlow) return;
		stopRef.current = false;
		setStatusMessage('Waiting for you to authorize…');

		(async () => {
			while (!stopRef.current) {
				try {
					const result = await pollDeviceFlow(projectId, connectorId, deviceFlow.flow_id);
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

	const handleCopyCode = async () => {
		if (!deviceFlow) return;
		await navigator.clipboard.writeText(deviceFlow.user_code);
		setCodeCopied(true);
		setTimeout(() => setCodeCopied(false), 2000);
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content
					data-testid="connector-device-flow-dialog"
					className={dialogContentClassName.md}
				>
					<Dialog.Title className="text-base font-semibold mb-1 flex items-center gap-2">
						<Plug className="size-4" />
						Connect {providerLabel}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-text-2 mb-4">
						Authorize Hezo on {providerLabel} by entering the code below on the page that just
						opened.
					</Dialog.Description>

					{errorMessage && (
						<div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger mb-4">
							{errorMessage}
						</div>
					)}

					{!deviceFlow && !errorMessage && (
						<div className="flex items-center gap-2 text-sm text-text-2">
							<Loader2 className="size-4 animate-spin" />
							{statusMessage || 'Starting…'}
						</div>
					)}

					{deviceFlow && (
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
									data-testid="connector-device-code"
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
							<p className="text-xs text-text-3">{statusMessage}</p>
						</div>
					)}

					<div className="flex justify-end mt-6">
						<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

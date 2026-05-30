import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, ExternalLink, Github, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
	type AuthStartDevice,
	type OAuthConnection,
	pollAuth,
	useAuthStart,
} from '../hooks/use-oauth-connections';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';

interface DeviceFlowDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	teamId: string;
	provider: 'github';
	scopes?: string[];
	onSuccess?: (connection: OAuthConnection) => void;
}

const PROVIDER_META: Record<
	DeviceFlowDialogProps['provider'],
	{ label: string; Icon: typeof Github }
> = {
	github: { label: 'GitHub', Icon: Github },
};

export function DeviceFlowDialog({
	open,
	onOpenChange,
	teamId,
	provider,
	scopes,
	onSuccess,
}: DeviceFlowDialogProps) {
	const authStart = useAuthStart(teamId);
	const [deviceFlow, setDeviceFlow] = useState<AuthStartDevice | null>(null);
	const [statusMessage, setStatusMessage] = useState('');
	const [errorMessage, setErrorMessage] = useState('');
	const [codeCopied, setCodeCopied] = useState(false);
	const stopRef = useRef(false);
	const startedRef = useRef(false);

	const authStartRef = useRef(authStart);
	authStartRef.current = authStart;
	const scopesRef = useRef(scopes);
	scopesRef.current = scopes;
	const providerRef = useRef(provider);
	providerRef.current = provider;
	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const onSuccessRef = useRef(onSuccess);
	onSuccessRef.current = onSuccess;

	const { label, Icon } = PROVIDER_META[provider];

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

		setStatusMessage(`Requesting a device code from ${label}…`);
		authStartRef.current
			.mutateAsync({ provider: providerRef.current, scopes: scopesRef.current })
			.then((result) => {
				if (result.flow !== 'device') {
					setErrorMessage(`Unexpected ${result.flow} flow from server`);
					setStatusMessage('');
					return;
				}
				setDeviceFlow(result);
				try {
					window.open(result.verification_uri, '_blank', 'noopener');
				} catch {
					/* pop-up blocked — user can copy verification_uri */
				}
			})
			.catch((e: Error) => {
				setErrorMessage(e.message);
				setStatusMessage('');
			});
	}, [open, label]);

	useEffect(() => {
		if (!deviceFlow) return;
		stopRef.current = false;
		setStatusMessage(`Waiting for you to authorize on ${label}…`);

		(async () => {
			while (!stopRef.current) {
				try {
					const result = await pollAuth(teamId, deviceFlow.flow_id);
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
	}, [deviceFlow, teamId, label]);

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
				<Dialog.Content data-testid="device-flow-dialog" className={dialogContentClassName.md}>
					<Dialog.Title className="text-base font-semibold mb-1 flex items-center gap-2">
						<Icon className="size-4" />
						Connect {label}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-text-muted mb-4">
						Authorize Hezo on {label} by entering the code below on the page that just opened.
					</Dialog.Description>

					{errorMessage && (
						<div className="rounded-radius-md border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-sm text-accent-red mb-4">
							{errorMessage}
						</div>
					)}

					{!deviceFlow && !errorMessage && (
						<div className="flex items-center gap-2 text-sm text-text-muted">
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
									data-testid="device-flow-code"
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
							<p className="text-xs text-text-subtle">{statusMessage}</p>
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

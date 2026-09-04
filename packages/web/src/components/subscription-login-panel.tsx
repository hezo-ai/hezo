import {
	type AgentRuntime,
	AI_PROVIDER_INFO,
	type AiProvider,
	type SubscriptionLoginFailure,
} from '@hezo/shared';
import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
	cancelSubscriptionLogin,
	invalidateAiProviders,
	pollSubscriptionLogin,
	type SubscriptionLoginState,
	startSubscriptionLogin,
	submitSubscriptionLoginCode,
} from '../hooks/use-ai-providers';
import { type MessageKey, useI18n } from '../lib/i18n';
import { type DeviceCodeState, DeviceCodeSteps } from './ui/device-code-steps';

/** How often the flow is polled while the operator is signing in elsewhere. */
const POLL_MS = 1500;

/**
 * The sentence shown for each way a sign-in can end without a credential.
 *
 * Total over the failure union, so a new code is a compile error here rather
 * than an operator reading the server's English inside a translated dialog.
 * `internal` is the one whose server message is a diagnostic rather than a
 * sentence, so its key is a lead and the message is kept underneath.
 */
const FAILURE_MESSAGE: Record<SubscriptionLoginFailure, MessageKey> = {
	unsupported: 'settings.provider.signIn.error.undrivable',
	probe_failed: 'settings.provider.signIn.error.undrivable',
	challenge_timeout: 'settings.provider.signIn.error.noLink',
	completion_timeout: 'settings.provider.signIn.error.expired',
	code_rejected: 'settings.provider.signIn.error.codeRejected',
	exited_without_credential: 'settings.provider.signIn.error.noCredential',
	cancelled: 'settings.provider.signIn.error.cancelled',
	internal: 'settings.provider.signIn.error.internal',
	poll_failed: 'settings.provider.signIn.error.unreachable',
	submit_failed: 'settings.provider.signIn.error.submitFailed',
};

interface SubscriptionLoginPanelProps {
	provider: AiProvider;
	/** Name the operator typed; stored as the config's label. */
	label?: string;
	/** CLI override, or null to follow the provider default. */
	runtime: AgentRuntime | null;
	/** The credential is stored server-side, so this carries no secret. */
	onDone: () => void;
	/**
	 * The CLI cannot be driven - no guided sign-in exists, or the installed
	 * version dropped the flag it needs. The caller falls back to manual paste
	 * **silently**: an operator can do nothing about a vendor's beta flag
	 * disappearing, so a warning would be noise. The server still names and logs
	 * it, so a CLI regression stays diagnosable.
	 */
	onUnavailable: () => void;
	onCancel: () => void;
}

/**
 * Runs one guided sign-in, from "Sign in" through to a stored credential.
 *
 * Mounted only once the operator has chosen subscription auth and clicked sign
 * in, so starting a flow (which creates a container) is always something they
 * asked for rather than a side effect of opening a dialog.
 *
 * Transport only. The code, the link and the sequence between them are
 * `DeviceCodeSteps`, shared with the connector device flow.
 */
export function SubscriptionLoginPanel({
	provider,
	label,
	runtime,
	onDone,
	onUnavailable,
	onCancel,
}: SubscriptionLoginPanelProps) {
	const { t } = useI18n();
	const info = AI_PROVIDER_INFO[provider];
	const [state, setState] = useState<SubscriptionLoginState>({ status: 'starting' });
	const [submitting, setSubmitting] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const flowIdRef = useRef<string | null>(null);
	const stopRef = useRef(false);

	// Latest callbacks without restarting the flow when the parent re-renders -
	// a restart would abandon a container and start a second sign-in.
	const doneRef = useRef(onDone);
	const unavailableRef = useRef(onUnavailable);
	doneRef.current = onDone;
	unavailableRef.current = onUnavailable;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger - bumping it abandons the failed flow and starts a fresh one
	useEffect(() => {
		stopRef.current = false;

		(async () => {
			let flowId: string;
			try {
				const started = await startSubscriptionLogin({ provider, label, runtime });
				flowId = started.flow_id;
				flowIdRef.current = flowId;
			} catch {
				// Every start failure lands the operator on manual paste. Distinguishing
				// "this CLI has no flow" from "the container would not start" would give
				// them two messages they act on identically.
				if (!stopRef.current) unavailableRef.current();
				return;
			}

			while (!stopRef.current) {
				let next: SubscriptionLoginState;
				try {
					next = await pollSubscriptionLogin(flowId);
				} catch (e) {
					if (!stopRef.current) {
						setState({
							status: 'failed',
							error: e instanceof Error ? e.message : String(e),
							code: 'poll_failed',
						});
					}
					return;
				}
				if (stopRef.current) return;
				setState(next);
				if (next.status === 'succeeded') {
					invalidateAiProviders();
					doneRef.current();
					return;
				}
				if (next.status === 'failed') return;
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
		})();

		return () => {
			stopRef.current = true;
			// Releases the container the moment the operator navigates away, rather
			// than leaving it to the flow's own 16-minute expiry.
			if (flowIdRef.current) void cancelSubscriptionLogin(flowIdRef.current);
		};
	}, [provider, label, runtime, attempt]);

	async function handleSubmitCode(code: string) {
		const flowId = flowIdRef.current;
		if (!flowId) return;
		setSubmitting(true);
		try {
			await submitSubscriptionLoginCode(flowId, code);
		} catch (e) {
			// The code never reached the CLI, so the poll below has nothing left to
			// report and the operator would be left pressing a button that does
			// nothing. Stop the loop and hand them the failure and its way out.
			stopRef.current = true;
			setState({
				status: 'failed',
				error: e instanceof Error ? e.message : String(e),
				code: 'submit_failed',
			});
		} finally {
			setSubmitting(false);
		}
	}

	function handleCancel() {
		stopRef.current = true;
		if (flowIdRef.current) void cancelSubscriptionLogin(flowIdRef.current);
		onCancel();
	}

	// The parent swaps this panel out on success; rendering a second confirmation
	// under the one it shows would be a duplicate.
	if (state.status === 'succeeded') return null;

	// A code this build has no sentence for - an older web against a newer server -
	// keeps the server's own message rather than rendering an empty banner.
	const failureKey = state.status === 'failed' ? FAILURE_MESSAGE[state.code] : undefined;

	const stepsState: DeviceCodeState =
		state.status === 'failed'
			? {
					status: 'failed',
					title: failureKey ? t(failureKey, { provider: info.name }) : state.error,
					detail: failureKey && state.code === 'internal' ? state.error : undefined,
				}
			: state.status === 'awaiting_user'
				? {
						status: 'awaiting',
						url: state.url,
						userCode: state.user_code,
						expiresAt: state.expires_at,
					}
				: { status: 'starting' };

	return (
		<DeviceCodeSteps
			testId="subscription-login-panel"
			title={t('settings.provider.signIn.heading', { provider: info.name })}
			providerLabel={info.name}
			icon={<KeyRound className="size-4" />}
			state={stepsState}
			returnCode={
				state.status === 'awaiting_user' && state.completion === 'code'
					? { submitting, onSubmit: handleSubmitCode }
					: undefined
			}
			onRetry={() => {
				// Released here rather than by the effect's cleanup, which sees the
				// cleared ref and lets a flow the server still holds run out its own
				// expiry - holding a container nobody is signing in to.
				if (flowIdRef.current) void cancelSubscriptionLogin(flowIdRef.current);
				setState({ status: 'starting' });
				flowIdRef.current = null;
				setAttempt((n) => n + 1);
			}}
			onCancel={handleCancel}
			fallback={{ label: t('settings.provider.signIn.manual'), onSelect: onUnavailable }}
		/>
	);
}

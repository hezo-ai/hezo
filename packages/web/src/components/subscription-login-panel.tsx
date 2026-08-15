import { type AgentRuntime, AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
	cancelSubscriptionLogin,
	invalidateAiProviders,
	pollSubscriptionLogin,
	type SubscriptionLoginState,
	startSubscriptionLogin,
	submitSubscriptionLoginCode,
} from '../hooks/use-ai-providers';
import { copyToClipboard } from '../lib/clipboard';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** How often the flow is polled while the operator is signing in elsewhere. */
const POLL_MS = 1500;

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
	const [code, setCode] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [copied, setCopied] = useState(false);
	const flowIdRef = useRef<string | null>(null);
	const stopRef = useRef(false);

	// Latest callbacks without restarting the flow when the parent re-renders -
	// a restart would abandon a container and start a second sign-in.
	const doneRef = useRef(onDone);
	const unavailableRef = useRef(onUnavailable);
	doneRef.current = onDone;
	unavailableRef.current = onUnavailable;

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
	}, [provider, label, runtime]);

	const handleCopy = useCallback(async () => {
		if (state.status !== 'awaiting_user' || !state.user_code) return;
		if (await copyToClipboard(state.user_code)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [state]);

	async function handleSubmitCode(e: React.FormEvent) {
		e.preventDefault();
		const flowId = flowIdRef.current;
		if (!flowId || !code.trim()) return;
		setSubmitting(true);
		try {
			await submitSubscriptionLoginCode(flowId, code.trim());
			setCode('');
		} finally {
			setSubmitting(false);
		}
	}

	function handleCancel() {
		stopRef.current = true;
		if (flowIdRef.current) void cancelSubscriptionLogin(flowIdRef.current);
		onCancel();
	}

	if (state.status === 'starting') {
		return (
			<div className="flex flex-col gap-4" data-testid="subscription-login-panel">
				<div className="flex flex-col items-center gap-2 py-10 text-center">
					<Loader2 className="w-5 h-5 animate-spin text-text-3" />
					<p className="text-sm text-text-2">
						{t('settings.provider.signIn.starting', { cli: info.runtimeLabel })}
					</p>
				</div>
				<div className="flex justify-end">
					<Button type="button" variant="ghost" onClick={handleCancel}>
						{t('common.cancel')}
					</Button>
				</div>
			</div>
		);
	}

	if (state.status === 'failed') {
		return (
			<div className="flex flex-col gap-4" data-testid="subscription-login-panel">
				<p className="text-[13px] text-danger">{state.error}</p>
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={handleCancel}>
						{t('common.cancel')}
					</Button>
					<Button type="button" onClick={onUnavailable}>
						{t('settings.provider.signIn.manual')}
					</Button>
				</div>
			</div>
		);
	}

	if (state.status === 'succeeded') return null;

	const needsCode = state.completion === 'code';

	return (
		<div className="flex flex-col gap-3" data-testid="subscription-login-panel">
			<p className="text-sm font-medium text-text-1">
				{needsCode
					? t('settings.provider.signIn.openLinkCode')
					: t('settings.provider.signIn.openLink')}
			</p>

			<a
				href={state.url}
				target="_blank"
				rel="noreferrer"
				className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 hover:border-border-strong"
			>
				<span className="truncate font-mono text-xs text-text-1">{state.url}</span>
				<ExternalLink className="w-3.5 h-3.5 shrink-0 text-text-3" />
			</a>

			{state.user_code && (
				<>
					<div className="rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-4 text-center">
						<div className="text-eyebrow text-text-3 mb-1.5">
							{t('settings.provider.signIn.oneTimeCode')}
						</div>
						{/* Tabular so the digits do not shift while it is read aloud off a phone. */}
						<div className="font-mono text-2xl font-bold tracking-[0.11em] tabular-nums text-text-1">
							{state.user_code}
						</div>
					</div>
					<Button type="button" variant="secondary" onClick={handleCopy}>
						{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
						{t(copied ? 'common.copied' : 'common.copy')}
					</Button>
				</>
			)}

			{needsCode ? (
				<form onSubmit={handleSubmitCode} className="flex flex-col gap-2">
					<Input
						label={t('settings.provider.signIn.codePrompt', { provider: info.name })}
						value={code}
						onChange={(e) => setCode(e.target.value)}
						autoComplete="off"
						spellCheck={false}
					/>
					<Button type="submit" disabled={!code.trim() || submitting}>
						{submitting && <Loader2 className="w-4 h-4 animate-spin" />}
						{t('common.continue')}
					</Button>
				</form>
			) : (
				<div className="flex items-center gap-2 text-[13px] text-text-2">
					<Loader2 className="w-3.5 h-3.5 animate-spin" />
					{t('settings.provider.signIn.waiting')}
				</div>
			)}

			<div className="flex justify-end">
				<Button type="button" variant="ghost" onClick={handleCancel}>
					{t('common.cancel')}
				</Button>
			</div>
		</div>
	);
}

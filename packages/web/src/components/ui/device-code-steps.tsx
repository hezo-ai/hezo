import { Check, Copy, ExternalLink, Link2, Loader2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { Trans, useI18n } from '../../lib/i18n';
import { Button, buttonClassName } from './button';
import { Callout } from './callout';
import { Input } from './input';

/**
 * The flow's server-side state, as the caller's own transport resolved it. The
 * component holds no polling loop and issues no request - each caller keeps the
 * transport it already has (RFC 8628 device poll, or the CLI-driven
 * subscription login) and feeds the outcome in.
 */
export type DeviceCodeState =
	| { status: 'starting' }
	| {
			status: 'awaiting';
			/** Where the operator finishes the sign-in. */
			url: string;
			/** null when the provider issues no code - the copy step disappears. */
			userCode: string | null;
			/** ISO timestamp; drives the countdown. Omit when the flow states no expiry. */
			expiresAt?: string | null;
	  }
	| { status: 'succeeded'; label?: string }
	| { status: 'failed'; title: string; detail?: string };

interface DeviceCodeStepsProps {
	/** "Connect GitHub", "Sign in with your OpenAI account". */
	title: string;
	/** Provider display name interpolated into the step copy ("GitHub"). */
	providerLabel: string;
	/** Provider glyph shown beside the title. */
	icon?: ReactNode;
	state: DeviceCodeState;
	/**
	 * Present only for a flow that hands a code back for the operator to bring
	 * here (Codex). Adds a third step; absent, step two ends in a wait.
	 */
	returnCode?: {
		submitting: boolean;
		onSubmit: (code: string) => void;
	};
	/** Offered on failure. Absent when the caller cannot restart in place. */
	onRetry?: () => void;
	/** Absent where the surrounding surface owns the way out. */
	onCancel?: () => void;
	/** The escape hatch when the guided flow cannot work ("Paste credential manually"). */
	fallback?: { label: string; onSelect: () => void };
	testId?: string;
}

/** Under this many seconds left, the countdown turns amber. */
const EXPIRY_WARN_SECONDS = 120;

/** Host of the verification URL, or the raw string when it will not parse. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function formatRemaining(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/** Seconds until `expiresAt`, ticking once a second; null when there is no expiry. */
function useSecondsRemaining(expiresAt: string | null | undefined): number | null {
	const [remaining, setRemaining] = useState<number | null>(null);

	useEffect(() => {
		if (!expiresAt) {
			setRemaining(null);
			return;
		}
		const deadline = new Date(expiresAt).getTime();
		if (Number.isNaN(deadline)) {
			setRemaining(null);
			return;
		}
		const tick = () => setRemaining(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [expiresAt]);

	return remaining;
}

type StepState = 'pending' | 'active' | 'done';

function StepMarker({ state, ordinal }: { state: StepState; ordinal: number }) {
	const shape =
		'flex size-[22px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums transition-colors';
	if (state === 'done') {
		return (
			<span className={`${shape} border-transparent bg-success-soft text-success-soft-fg`}>
				<Check className="size-3" strokeWidth={3.5} />
			</span>
		);
	}
	if (state === 'active') {
		return (
			<span
				className={`${shape} border-transparent bg-accent-solid text-accent-solid-fg ring-[3px] ring-ring`}
			>
				{ordinal}
			</span>
		);
	}
	return <span className={`${shape} border-border-strong text-text-3`}>{ordinal}</span>;
}

function Step({
	state,
	ordinal,
	title,
	last,
	children,
	testId,
}: {
	state: StepState;
	ordinal: number;
	title: string;
	last: boolean;
	children?: ReactNode;
	testId: string;
}) {
	return (
		<li className="grid grid-cols-[22px_1fr] gap-x-2.5" data-testid={testId} data-state={state}>
			<div className="flex flex-col items-center gap-1">
				<StepMarker state={state} ordinal={ordinal} />
				{!last && <span className="w-px flex-1 min-h-2 bg-border" />}
			</div>
			<div className={`flex min-w-0 flex-col gap-2 ${last ? '' : 'pb-3.5'}`}>
				<div
					className={`pt-0.5 text-[13px] font-medium ${
						state === 'pending' ? 'text-text-3' : state === 'done' ? 'text-text-2' : 'text-text-1'
					}`}
				>
					{title}
				</div>
				{children}
			</div>
		</li>
	);
}

/**
 * The shared device sign-in surface: copy a one-time code, take it to the
 * provider's page, and (for the flows that hand one back) bring a code home.
 *
 * The steps are the point. Both flows this replaced rendered a code, a link and
 * a status line with nothing saying which came first, so the numbered rail runs
 * the sequence: exactly one step is active, finished steps collapse to a
 * one-line receipt that still shows the code, and only the active step carries
 * a filled button. The rail adapts to the flow it is given - no `userCode`
 * drops the copy step, a `returnCode` adds a third, and the ordinals follow.
 *
 * Opening the provider's page is a real anchor the operator clicks, never an
 * automatic `window.open`: a pop-up fired before the code is on screen lands
 * them on a page asking for something they have not seen, and gets blocked
 * often enough that the code was the only thing left to work with.
 */
export function DeviceCodeSteps({
	title,
	providerLabel,
	icon,
	state,
	returnCode,
	onRetry,
	onCancel,
	fallback,
	testId = 'device-code-steps',
}: DeviceCodeStepsProps) {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [opened, setOpened] = useState(false);
	const [returned, setReturned] = useState('');
	const openRef = useRef<HTMLAnchorElement>(null);

	const userCode = state.status === 'awaiting' ? state.userCode : null;
	const url = state.status === 'awaiting' ? state.url : '';
	const remaining = useSecondsRemaining(state.status === 'awaiting' ? state.expiresAt : null);

	// A restarted flow issues a new code, so the rail starts over rather than
	// claiming the operator already copied the one that just replaced it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the new code is the trigger, and none of the setters read it
	useEffect(() => {
		setCopied(false);
		setCopyFailed(false);
		setOpened(false);
	}, [userCode]);

	// Move focus onto the next step's action, so the sequence is followable
	// without hunting for where the primary button went.
	useEffect(() => {
		if (copied) openRef.current?.focus();
	}, [copied]);

	async function handleCopy() {
		if (!userCode) return;
		const ok = await copyToClipboard(userCode);
		setCopied(ok);
		setCopyFailed(!ok);
	}

	if (state.status === 'succeeded') {
		return (
			<div className="flex flex-col gap-3" data-testid={testId} data-status="succeeded">
				<Callout tone="success" icon={<Check className="size-4" strokeWidth={2.5} />}>
					<span className="font-medium">
						{state.label ?? t('deviceSignIn.connected', { provider: providerLabel })}
					</span>
				</Callout>
			</div>
		);
	}

	if (state.status === 'failed') {
		return (
			<div className="flex flex-col gap-4" data-testid={testId} data-status="failed">
				<Callout tone="danger" icon={<TriangleAlert className="size-4" />} title={state.title}>
					{state.detail && <span className="opacity-85">{state.detail}</span>}
				</Callout>
				<div className="flex flex-wrap justify-end gap-2">
					{onCancel && (
						<Button type="button" variant="secondary" onClick={onCancel}>
							{t('common.cancel')}
						</Button>
					)}
					{fallback && (
						<Button type="button" variant="ghost" onClick={fallback.onSelect}>
							{fallback.label}
						</Button>
					)}
					{onRetry && (
						<Button type="button" onClick={onRetry} data-testid="device-code-retry">
							{t('deviceSignIn.action.newCode')}
						</Button>
					)}
				</div>
			</div>
		);
	}

	const starting = state.status === 'starting';
	const host = starting ? providerLabel : hostOf(url);
	// The copy step exists only when there is something to copy; the ordinals
	// below are positions in the rail, never fixed numbers.
	const hasCopyStep = starting || userCode !== null;
	const copyDone = hasCopyStep ? copied : true;
	const copyOrdinal = 1;
	const openOrdinal = hasCopyStep ? 2 : 1;
	const pasteOrdinal = openOrdinal + 1;

	const copyState: StepState = starting ? 'pending' : copyDone ? 'done' : 'active';
	const openState: StepState = starting || !copyDone ? 'pending' : opened ? 'done' : 'active';
	const pasteState: StepState = opened ? 'active' : 'pending';

	const subtitle = starting
		? t('deviceSignIn.subtitle.starting', { provider: providerLabel })
		: !copyDone
			? t('deviceSignIn.subtitle.copy', { host })
			: !opened
				? hasCopyStep
					? t('deviceSignIn.subtitle.open', { host })
					: t('deviceSignIn.subtitle.openOnly', { host })
				: returnCode
					? t('deviceSignIn.subtitle.paste', { provider: providerLabel })
					: t('deviceSignIn.subtitle.waiting');

	return (
		<div className="flex flex-col gap-3.5" data-testid={testId} data-status={state.status}>
			<div className="flex items-start gap-2.5">
				{icon && (
					<span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-3 text-text-2">
						{starting ? <Loader2 className="size-4 animate-spin" /> : icon}
					</span>
				)}
				<div className="min-w-0">
					<h3 className="text-[13.5px] font-semibold text-text-1">{title}</h3>
					<p className="mt-0.5 text-[12.5px] text-text-2">{subtitle}</p>
				</div>
			</div>

			<ol className="flex flex-col">
				{hasCopyStep && (
					<Step
						state={copyState}
						ordinal={copyOrdinal}
						last={false}
						testId="device-code-step-copy"
						title={
							copyState === 'done' ? t('deviceSignIn.step.copyDone') : t('deviceSignIn.step.copy')
						}
					>
						{copyState === 'done' ? (
							<div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
								<Trans
									k="deviceSignIn.copiedCode"
									vars={{
										code: (
											<code className="select-all rounded-sm border border-border bg-surface-2 px-1.5 py-px font-mono text-xs text-text-1">
												{userCode}
											</code>
										),
									}}
								/>
								<Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
									{t('deviceSignIn.action.copyAgain')}
								</Button>
							</div>
						) : (
							<>
								<div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-3.5 text-center">
									{/* Tabular so the digits do not shift while it is read off a phone.
									    The test id lands only on a real code, so a spec waiting for one
									    is not answered by the placeholder standing in for it. */}
									<div
										className="select-all break-all font-mono text-[22px] font-semibold tracking-[0.14em] tabular-nums text-text-1"
										data-testid={userCode ? 'device-code-value' : undefined}
									>
										{userCode ?? (
											<span className="inline-block h-6 w-32 animate-pulse rounded-sm bg-surface-3 align-middle" />
										)}
									</div>
									{remaining !== null && (
										<div
											className={`text-[11.5px] tabular-nums ${
												remaining <= EXPIRY_WARN_SECONDS ? 'text-warning-soft-fg' : 'text-text-3'
											}`}
											data-testid="device-code-expiry"
										>
											{remaining === 0
												? t('deviceSignIn.expired')
												: t('deviceSignIn.expiresIn', { time: formatRemaining(remaining) })}
										</div>
									)}
								</div>
								{copyFailed && (
									<p
										className="text-[12px] text-warning-soft-fg"
										data-testid="device-code-copy-failed"
									>
										{t('deviceSignIn.copyFailed')}
									</p>
								)}
								<Button
									type="button"
									className="w-full"
									disabled={starting}
									onClick={copyFailed ? () => setCopied(true) : handleCopy}
									data-testid="device-code-copy"
								>
									{copyFailed ? null : <Copy className="size-3.5" />}
									{copyFailed ? t('common.continue') : t('deviceSignIn.action.copy')}
								</Button>
							</>
						)}
					</Step>
				)}

				<Step
					state={openState}
					ordinal={openOrdinal}
					last={!returnCode}
					testId="device-code-step-open"
					title={
						openState === 'done'
							? t('deviceSignIn.step.openDone', { host })
							: hasCopyStep
								? t('deviceSignIn.step.open', { host })
								: t('deviceSignIn.step.openOnly', { host })
					}
				>
					{openState === 'active' && (
						<>
							<div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2">
								<Link2 className="size-3.5 shrink-0 text-text-3" />
								<span className="truncate font-mono text-xs text-text-1">{url}</span>
							</div>
							{/* A real anchor, not window.open: middle-click and "open in new tab"
							    work, and a click the operator made is never pop-up blocked. */}
							<a
								ref={openRef}
								href={url}
								target="_blank"
								rel="noreferrer"
								onClick={() => setOpened(true)}
								className={buttonClassName({ className: 'w-full' })}
								data-testid="device-code-open"
							>
								{t('deviceSignIn.action.open', { provider: providerLabel })}
								<ExternalLink className="size-3.5" />
							</a>
						</>
					)}
					{openState === 'done' && !returnCode && (
						<>
							<div className="flex items-center gap-2 text-[12.5px] text-text-2">
								<span className="relative size-[7px] shrink-0 rounded-full bg-accent">
									<span className="absolute -inset-1 animate-ping rounded-full border border-accent opacity-50" />
								</span>
								{t('deviceSignIn.waiting', { host })}
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<a
									href={url}
									target="_blank"
									rel="noreferrer"
									className={buttonClassName({ variant: 'secondary', size: 'sm' })}
								>
									{t('deviceSignIn.action.openAgain')}
								</a>
								{userCode && (
									<Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
										{t('deviceSignIn.action.copyAgain')}
									</Button>
								)}
							</div>
						</>
					)}
					{openState === 'done' && returnCode && (
						<a
							href={url}
							target="_blank"
							rel="noreferrer"
							className={buttonClassName({ variant: 'ghost', size: 'sm', className: 'self-start' })}
						>
							{t('deviceSignIn.action.openAgain')}
						</a>
					)}
				</Step>

				{returnCode && (
					<Step
						state={pasteState}
						ordinal={pasteOrdinal}
						last
						testId="device-code-step-paste"
						title={t('deviceSignIn.step.paste', { provider: providerLabel })}
					>
						{pasteState === 'active' && (
							<form
								className="flex flex-col gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									if (returned.trim()) returnCode.onSubmit(returned.trim());
								}}
							>
								<Input
									label={t('deviceSignIn.pasteLabel', { provider: providerLabel })}
									value={returned}
									onChange={(e) => setReturned(e.target.value)}
									autoComplete="off"
									spellCheck={false}
									data-testid="device-code-return-input"
								/>
								<Button
									type="submit"
									disabled={!returned.trim() || returnCode.submitting}
									data-testid="device-code-return-submit"
								>
									{returnCode.submitting && <Loader2 className="size-3.5 animate-spin" />}
									{t('deviceSignIn.action.finish')}
								</Button>
							</form>
						)}
					</Step>
				)}
			</ol>

			{(fallback || onCancel) && (
				<div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
					{fallback && (
						<Button type="button" variant="ghost" onClick={fallback.onSelect}>
							{fallback.label}
						</Button>
					)}
					{onCancel && (
						<Button type="button" variant="secondary" onClick={onCancel}>
							{t('common.cancel')}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

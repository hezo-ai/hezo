import {
	generateMnemonic,
	type MasterKeyState,
	normalizeMnemonic,
	validateMnemonic,
} from '@hezo/shared';
import {
	AlertTriangle,
	Copy,
	Eye,
	EyeOff,
	KeyRound,
	Loader2,
	Lock,
	RefreshCw,
	ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { authenticateWithMnemonic } from '../lib/auth';
import { copyToClipboard } from '../lib/clipboard';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { GateLocaleSwitcher } from './locale/locale-switcher';
import { BackLink } from './ui/back-link';
import { Button } from './ui/button';
import { PageLogo } from './ui/page-logo';
import { PasswordInput } from './ui/password-input';
import { Tooltip } from './ui/tooltip';

const REVEAL_STRIPS = 11;
/** How long the words shimmer as placeholders before a regenerated phrase appears. */
const REGEN_ANIM_MS = 1200;
/** Seconds Continue stays disabled after the key is copied, nudging the user to actually save it. */
const SAVE_COUNTDOWN_SECONDS = 5;

/**
 * Full-viewport setup / unlock chrome. Follows the active theme (light or dark)
 * like the rest of the app; the card sits centered under the brand logo. Used by
 * the master-key setup + unlock + recovery screens.
 */
export function VaultShell({ children }: { children: ReactNode }) {
	return (
		<div className="relative min-h-screen flex flex-col items-center justify-center bg-bg px-4 py-10">
			{/* The locale control stays reachable on every pre-auth gate, so an
			    operator can switch language mid-setup or at the unlock screen. */}
			<GateLocaleSwitcher />
			<PageLogo />
			<div className="w-full max-w-md">{children}</div>
		</div>
	);
}

/** The vertical-blind reveal overlay; calls `onDone` after the last strip collapses. */
function UnlockReveal({ onDone }: { onDone: () => void }) {
	return (
		<div className="vault-reveal" aria-hidden="true">
			{Array.from({ length: REVEAL_STRIPS }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative strip list
					key={i}
					className="vault-reveal-strip"
					style={{ '--i': i } as React.CSSProperties}
					onAnimationEnd={i === REVEAL_STRIPS - 1 ? onDone : undefined}
				/>
			))}
		</div>
	);
}

interface MasterKeyFormProps {
	state: MasterKeyState;
	/** When true, omit the dialog header (caller renders its own page-level heading). */
	embedded?: boolean;
	/**
	 * When provided, called after the master key is accepted instead of the default
	 * unlock reveal + status refetch. Used by the password-recovery flow, where the
	 * mnemonic only fetches a password-setup token and the caller advances to the
	 * create-password step itself.
	 */
	onAuthenticated?: () => void;
}

export function MasterKeyForm({ state, embedded, onAuthenticated }: MasterKeyFormProps) {
	const [key, setKey] = useState('');
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	const [revealing, setRevealing] = useState(false);
	// Setup is a two-step flow: generate + save the key, then paste it back to
	// confirm before it's committed. `phase` only matters when `isUnset`.
	const [phase, setPhase] = useState<'generate' | 'confirm'>('generate');
	// The generated words start masked (password-style); the eye toggle reveals them.
	const [revealed, setRevealed] = useState(false);
	// The word grid shimmers as placeholders while a regenerated phrase is prepared.
	const [regenerating, setRegenerating] = useState(false);
	// Continue only appears once the user has copied the key, then stays disabled
	// for a short countdown so they actually stash it before advancing.
	const [copyClicked, setCopyClicked] = useState(false);
	const [countdown, setCountdown] = useState(SAVE_COUNTDOWN_SECONDS);

	const regenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (regenTimer.current) clearTimeout(regenTimer.current);
		},
		[],
	);

	const isUnset = state === 'unset';

	// Tick the post-copy countdown down to zero, which enables Continue.
	useEffect(() => {
		if (!copyClicked || countdown <= 0) return;
		const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
		return () => clearTimeout(id);
	}, [copyClicked, countdown]);

	function resetSaveGate() {
		setCopyClicked(false);
		setCountdown(SAVE_COUNTDOWN_SECONDS);
	}

	function handleGenerate() {
		setError('');
		setRevealed(false);
		resetSaveGate();
		const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
		// First generation (nothing to animate) or reduced motion: swap instantly.
		if (!generatedKey || reduceMotion) {
			setGeneratedKey(generateMnemonic());
			return;
		}
		// Regenerating: shimmer the existing grid, then reveal the fresh phrase.
		setRegenerating(true);
		regenTimer.current = setTimeout(() => {
			setGeneratedKey(generateMnemonic());
			setRegenerating(false);
		}, REGEN_ANIM_MS);
	}

	function goToConfirm() {
		setError('');
		setKey('');
		setRevealed(false);
		setPhase('confirm');
	}

	function goBackToGenerate() {
		setError('');
		setKey('');
		setRevealed(false);
		setPhase('generate');
	}

	function finishTransition() {
		// Refetch status (now unlocked) + the session probe so the gate advances.
		queryClient.invalidateQueries({ queryKey: queryKeys.status() });
		queryClient.invalidateQueries({ queryKey: queryKeys.me() });
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		// In setup we're always on the confirm step here: the pasted phrase must
		// match the phrase we generated, so we know the user captured all 12 words.
		if (isUnset && normalizeMnemonic(key) !== generatedKey) {
			setError("That doesn't match your master key. Paste all 12 words exactly.");
			return;
		}
		const phrase = isUnset ? (generatedKey ?? '') : normalizeMnemonic(key);
		if (!phrase) return;
		setError('');
		if (!validateMnemonic(phrase)) {
			setError('That is not a valid 12-word master key.');
			return;
		}
		setLoading(true);
		try {
			await authenticateWithMnemonic(phrase, state);
			if (onAuthenticated) {
				onAuthenticated();
				return;
			}
			// Play the unlock reveal; the last strip triggers the gate transition.
			if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
				finishTransition();
			} else {
				setRevealing(true);
			}
		} catch (err: unknown) {
			const apiErr = err as { message?: string };
			setError(apiErr.message || 'Invalid master key');
			setLoading(false);
		}
	}

	async function handleCopy() {
		// Best-effort copy; the click itself opens the save gate either way so the
		// user is never stranded if the clipboard API is unavailable.
		await copyToClipboard(generatedKey ?? '');
		setCopyClicked(true);
		setCountdown(SAVE_COUNTDOWN_SECONDS);
	}

	const heading = !isUnset
		? 'Unlock Hezo'
		: phase === 'confirm'
			? 'Confirm you saved your key'
			: 'Create your master key';
	const subtitle = !isUnset
		? 'The instance is locked. Enter your 12-word master key to bring it back online.'
		: phase === 'confirm'
			? 'Paste the 12 words back so we know you have the full phrase. You can always go back.'
			: // Generate phase: the callout below the heading replaces a one-line subtitle.
				null;

	// The generate-phase word grid + the confirm/unlock entry field.
	const showGenerated = isUnset && phase === 'generate' && generatedKey !== null;
	const showEntry = !isUnset || phase === 'confirm';

	// During regeneration the words are hidden behind shimmering placeholders.
	const gridWords = regenerating
		? Array.from({ length: 12 }, () => '')
		: (generatedKey ?? '').split(' ');

	return (
		<>
			{revealing && <UnlockReveal onDone={finishTransition} />}
			{isUnset && phase === 'confirm' && (
				<div className="mb-3">
					<BackLink onClick={goBackToGenerate} />
				</div>
			)}
			{!embedded && (
				<div className="flex flex-col items-center gap-2 mb-6">
					<div className="p-3 rounded-full bg-surface-2 border border-border-strong text-accent-soft-fg">
						{isUnset ? <KeyRound className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
					</div>
					<h2 className="text-lg font-semibold text-text-1">{heading}</h2>
					{subtitle && <p className="text-sm text-text-2 text-center">{subtitle}</p>}
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				{isUnset && phase === 'generate' && !generatedKey && (
					<Button type="button" variant="secondary" onClick={handleGenerate}>
						<KeyRound className="w-4 h-4" />
						Generate master key
					</Button>
				)}

				{showGenerated && (
					<div className="flex flex-col gap-2.5 rounded-md border border-warning-soft-fg/25 bg-warning-soft px-3 py-3 text-[12.5px] leading-relaxed text-warning-soft-fg">
						<div className="flex gap-2.5 items-start">
							<KeyRound className="w-4 h-4 shrink-0 mt-0.5" />
							<span>
								<span className="font-semibold text-text-1">
									Encrypts everything, unlocks every restart.
								</span>{' '}
								This key protects all data in your instance and brings it back online after each
								restart.
							</span>
						</div>
						<div className="flex gap-2.5 items-start">
							<AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
							<span>
								<span className="font-semibold text-text-1">
									No one can recover it — not even Hezo.
								</span>{' '}
								Lose these words and your data is locked away for good.
							</span>
						</div>
						<div className="flex gap-2.5 items-start">
							<Lock className="w-4 h-4 shrink-0 mt-0.5" />
							<span>
								<span className="font-semibold text-text-1">Save it now</span> in a password manager
								or another safe place — you'll confirm it on the next step.
							</span>
						</div>
					</div>
				)}

				{showGenerated && (
					<div className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<span className="text-eyebrow text-text-2">Your master key</span>
								<Tooltip content="Generate a new master key">
									<button
										type="button"
										onClick={handleGenerate}
										disabled={regenerating}
										aria-label="Generate a new key"
										className="text-text-3 hover:text-text-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
									>
										<RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
									</button>
								</Tooltip>
							</div>
							<button
								type="button"
								onClick={() => setRevealed((v) => !v)}
								disabled={regenerating}
								aria-label={revealed ? 'Hide key' : 'Show key'}
								className="flex items-center gap-1.5 text-xs text-text-3 hover:text-text-1 disabled:opacity-40"
							>
								{revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
								{revealed ? 'Hide' : 'Show'}
							</button>
						</div>
						<ol
							className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
							aria-label="Master key"
						>
							{gridWords.map((word, index) => (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, never-reordered list with possibly-repeating words; position is the stable identity
									key={index}
									data-testid="mnemonic-word"
									className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1.5"
								>
									<span className="w-4 text-right text-[10px] tabular-nums text-text-3 select-none">
										{index + 1}
									</span>
									{regenerating ? (
										<span
											className="h-3 flex-1 rounded bg-surface-3 animate-pulse"
											aria-hidden="true"
										/>
									) : (
										<span className="font-mono text-xs text-text-1">
											{revealed ? word : '••••••'}
										</span>
									)}
								</li>
							))}
						</ol>
					</div>
				)}

				{showEntry && (
					<div className="flex flex-col gap-1.5">
						<label htmlFor="mnemonic-entry" className="text-sm font-medium text-text-1">
							Master Key
						</label>
						<PasswordInput
							id="mnemonic-entry"
							revealLabel="key"
							className="font-mono"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder={
								isUnset ? 'Paste your 12-word master key' : 'Enter your 12-word master key'
							}
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
						/>
					</div>
				)}

				{error && <p className="text-sm text-danger">{error}</p>}

				{showGenerated &&
					(copyClicked ? (
						<div className="flex flex-col gap-1.5">
							<Button type="button" onClick={goToConfirm} disabled={countdown > 0}>
								{countdown > 0 ? `Continue (${countdown})` : 'Continue'}
							</Button>
							{countdown > 0 && (
								<p className="text-center text-xs text-text-3">
									Take a moment to save your key somewhere safe.
								</p>
							)}
						</div>
					) : (
						<Button type="button" onClick={handleCopy} disabled={regenerating}>
							<Copy className="w-4 h-4" />
							Copy to clipboard
						</Button>
					))}

				{isUnset && phase === 'confirm' && (
					<Button
						type="submit"
						shortcut="Enter"
						shortcutFire={false}
						disabled={loading || !key.trim()}
					>
						{loading && <Loader2 className="w-4 h-4 animate-spin" />}
						Confirm key and continue
					</Button>
				)}

				{!isUnset && (
					<Button
						type="submit"
						shortcut="Enter"
						shortcutFire={false}
						disabled={loading || !key.trim()}
					>
						{loading && <Loader2 className="w-4 h-4 animate-spin" />}
						Unlock
					</Button>
				)}
			</form>
		</>
	);
}

interface MasterKeyGateProps {
	state: MasterKeyState;
}

/** Full-page vault screen: master-key setup (unset) or unlock-on-restart (locked). */
export function MasterKeyGate({ state }: MasterKeyGateProps) {
	return (
		<VaultShell>
			<div
				data-testid={state === 'unset' ? 'master-key-setup' : 'master-key-unlock'}
				className="rounded-2xl border border-border-strong bg-surface p-6 sm:p-8 shadow-[var(--elev-lg)]"
			>
				<MasterKeyForm state={state} />
			</div>
		</VaultShell>
	);
}

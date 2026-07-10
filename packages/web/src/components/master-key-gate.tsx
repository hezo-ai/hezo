import {
	generateMnemonic,
	type MasterKeyState,
	normalizeMnemonic,
	validateMnemonic,
} from '@hezo/shared';
import { AlertTriangle, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { authenticateWithMnemonic } from '../lib/auth';
import { copyToClipboard } from '../lib/clipboard';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { Button } from './ui/button';
import { Logo } from './ui/logo';
import { PasswordInput } from './ui/password-input';

const REVEAL_STRIPS = 11;

/**
 * Full-viewport "pre-active vault" chrome. Always dark (via `.vault-surface`),
 * visually distinct from the running app so it reads as "the instance is not
 * live yet". Used by the master-key setup + unlock + recovery screens.
 */
export function VaultShell({ children }: { children: ReactNode }) {
	return (
		<div className="vault-surface min-h-screen flex flex-col items-center justify-center bg-bg px-4 py-10">
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
	const [copied, setCopied] = useState(false);
	const [revealing, setRevealing] = useState(false);
	// Setup is a two-step flow: generate + save the key, then paste it back to
	// confirm before it's committed. `phase` only matters when `isUnset`.
	const [phase, setPhase] = useState<'generate' | 'confirm'>('generate');
	// The generated words start masked (password-style); the eye toggle reveals them.
	const [revealed, setRevealed] = useState(false);

	const isUnset = state === 'unset';

	function handleGenerate() {
		setGeneratedKey(generateMnemonic());
		setRevealed(false);
		setCopied(false);
		setError('');
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
		if (await copyToClipboard(generatedKey ?? '')) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}

	const heading = !isUnset
		? 'Unlock Hezo'
		: phase === 'confirm'
			? 'Confirm you saved your key'
			: 'Create your master key';
	const subtitle = !isUnset
		? 'The instance is locked. Enter your 12-word master key to bring it back online.'
		: phase === 'confirm'
			? 'Paste the 12 words back so we know you have the full phrase. You can go back and generate a new one.'
			: 'The one key that encrypts your data and unlocks this instance.';

	// The generate-phase word grid + the confirm/unlock entry field.
	const showGenerated = isUnset && phase === 'generate' && generatedKey !== null;
	const showEntry = !isUnset || phase === 'confirm';

	return (
		<>
			{revealing && <UnlockReveal onDone={finishTransition} />}
			{!embedded && (
				<div className="flex flex-col items-center gap-2 mb-6">
					<Logo size="lg" wordmark className="mb-1" />
					<div className="p-3 rounded-full bg-surface-2 border border-border-strong text-accent-soft-fg">
						{isUnset ? <KeyRound className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
					</div>
					<h2 className="text-lg font-semibold text-text-1">{heading}</h2>
					<p className="text-sm text-text-2 text-center">{subtitle}</p>
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
					<div className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<span className="text-eyebrow text-text-2">Your master key</span>
							<button
								type="button"
								onClick={() => setRevealed((v) => !v)}
								aria-label={revealed ? 'Hide key' : 'Show key'}
								className="flex items-center gap-1.5 text-xs text-text-3 hover:text-text-1"
							>
								{revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
								{revealed ? 'Hide' : 'Show'}
							</button>
						</div>
						<ol
							className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
							aria-label="Master key"
						>
							{(generatedKey ?? '').split(' ').map((word, index) => (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, never-reordered list with possibly-repeating words; position is the stable identity
									key={index}
									data-testid="mnemonic-word"
									className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1.5"
								>
									<span className="w-4 text-right text-[10px] tabular-nums text-text-3 select-none">
										{index + 1}
									</span>
									<span className="font-mono text-xs text-text-1">
										{revealed ? word : '••••••'}
									</span>
								</li>
							))}
						</ol>
						<Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
							{copied ? 'Copied!' : 'Copy to clipboard'}
						</Button>
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
									<span className="font-semibold text-text-1">Save it now</span> in a password
									manager or another safe place — you'll confirm it on the next step.
								</span>
							</div>
						</div>
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

				{showGenerated && (
					<div className="flex flex-col gap-2">
						<Button type="button" onClick={goToConfirm}>
							Continue
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={handleGenerate}>
							Generate a new key
						</Button>
					</div>
				)}

				{isUnset && phase === 'confirm' && (
					<div className="flex flex-col gap-2">
						<Button type="submit" disabled={loading || !key.trim()}>
							{loading && <Loader2 className="w-4 h-4 animate-spin" />}
							Set key & continue
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={goBackToGenerate}>
							Back
						</Button>
					</div>
				)}

				{!isUnset && (
					<Button type="submit" disabled={loading || !key.trim()}>
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

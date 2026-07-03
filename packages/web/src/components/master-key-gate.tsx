import {
	generateMnemonic,
	type MasterKeyState,
	normalizeMnemonic,
	validateMnemonic,
} from '@hezo/shared';
import { KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { authenticateWithMnemonic } from '../lib/auth';
import { copyToClipboard } from '../lib/clipboard';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { Button } from './ui/button';
import { Logo } from './ui/logo';

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

	const isUnset = state === 'unset';

	function handleGenerate() {
		setGeneratedKey(generateMnemonic());
	}

	function finishTransition() {
		// Refetch status (now unlocked) + the session probe so the gate advances.
		queryClient.invalidateQueries({ queryKey: queryKeys.status() });
		queryClient.invalidateQueries({ queryKey: queryKeys.me() });
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
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

	return (
		<>
			{revealing && <UnlockReveal onDone={finishTransition} />}
			{!embedded && (
				<div className="flex flex-col items-center gap-2 mb-6">
					<Logo size="lg" wordmark className="mb-1" />
					<div className="p-3 rounded-full bg-surface-2 border border-border-strong text-accent-soft-fg">
						{isUnset ? <KeyRound className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
					</div>
					<h2 className="text-lg font-semibold text-text-1">
						{isUnset ? 'Create your master key' : 'Unlock Hezo'}
					</h2>
					<p className="text-sm text-text-2 text-center">
						{isUnset
							? 'This 12-word key unlocks the instance and encrypts everything in it.'
							: 'The instance is locked. Enter your 12-word master key to bring it back online.'}
					</p>
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				{isUnset && !generatedKey && (
					<Button type="button" variant="secondary" onClick={handleGenerate}>
						<KeyRound className="w-4 h-4" />
						Generate master key
					</Button>
				)}

				{generatedKey && (
					<div className="flex flex-col gap-3">
						<ol
							className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
							aria-label="Master key"
						>
							{generatedKey.split(' ').map((word, index) => (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, never-reordered list with possibly-repeating words; position is the stable identity
									key={index}
									data-testid="mnemonic-word"
									className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1.5"
								>
									<span className="w-4 text-right text-[10px] tabular-nums text-text-3 select-none">
										{index + 1}
									</span>
									<span className="font-mono text-xs text-text-1">{word}</span>
								</li>
							))}
						</ol>
						<Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
							{copied ? 'Copied!' : 'Copy to clipboard'}
						</Button>
						<div className="flex gap-2.5 items-start rounded-md border border-warning-soft-fg/25 bg-warning-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warning-soft-fg">
							<Lock className="w-4 h-4 shrink-0 mt-0.5" />
							<span>
								<span className="font-semibold text-text-1">
									Store these words somewhere safe now.
								</span>{' '}
								They're the only way to unlock the instance after a restart and to reset a forgotten
								password. Hezo can't recover them for you.
							</span>
						</div>
					</div>
				)}

				{!isUnset && (
					<div className="flex flex-col gap-1.5">
						<label htmlFor="mnemonic-entry" className="text-sm font-medium text-text-1">
							Master Key
						</label>
						<textarea
							id="mnemonic-entry"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder="Enter your 12-word master key"
							rows={3}
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							className="w-full resize-none rounded-md border border-border-strong bg-surface-2 p-2.5 font-mono text-xs text-text-1 placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-accent"
						/>
					</div>
				)}

				{error && <p className="text-sm text-danger">{error}</p>}

				<Button type="submit" disabled={loading || (isUnset ? !generatedKey : !key.trim())}>
					{loading && <Loader2 className="w-4 h-4 animate-spin" />}
					{isUnset ? 'Set key & continue' : 'Unlock'}
				</Button>
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

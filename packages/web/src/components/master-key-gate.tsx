import {
	generateMnemonic,
	type MasterKeyState,
	normalizeMnemonic,
	validateMnemonic,
} from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { authenticateWithMnemonic } from '../lib/auth';
import { copyToClipboard } from '../lib/clipboard';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { Button } from './ui/button';
import { dialogContentClassName } from './ui/dialog';
import { Logo } from './ui/logo';

interface MasterKeyFormProps {
	state: MasterKeyState;
	/** When true, omit the dialog header (caller renders its own page-level heading). */
	embedded?: boolean;
}

export function MasterKeyForm({ state, embedded }: MasterKeyFormProps) {
	const [key, setKey] = useState('');
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	const [copied, setCopied] = useState(false);

	const isUnset = state === 'unset';

	function handleGenerate() {
		setGeneratedKey(generateMnemonic());
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
			queryClient.invalidateQueries({ queryKey: queryKeys.status() });
		} catch (err: unknown) {
			const apiErr = err as { message?: string };
			setError(apiErr.message || 'Invalid master key');
		} finally {
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
			{!embedded && (
				<div className="flex flex-col items-center gap-2 mb-6">
					<Logo size="lg" wordmark className="mb-1" />
					<div className="p-3 rounded-full bg-surface-2 border border-border">
						{isUnset ? (
							<KeyRound className="w-6 h-6 text-text-2" />
						) : (
							<ShieldCheck className="w-6 h-6 text-text-2" />
						)}
					</div>
					<Dialog.Title className="text-lg font-semibold text-text-1">
						{isUnset ? 'Set Master Key' : 'Unlock Hezo'}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-text-2 text-center">
						{isUnset
							? "Your master key is these 12 words. Save them somewhere safe — you'll need them to unlock Hezo on restart."
							: 'Enter your 12-word master key to unlock the server.'}
					</Dialog.Description>
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				{isUnset && !generatedKey && (
					<Button type="button" variant="secondary" onClick={handleGenerate}>
						<KeyRound className="w-4 h-4" />
						Generate Key
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
									className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5"
								>
									<span className="w-4 text-right text-[10px] tabular-nums text-text-2 select-none">
										{index + 1}
									</span>
									<span className="font-mono text-xs text-text-1">{word}</span>
								</li>
							))}
						</ol>
						<Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
							{copied ? 'Copied!' : 'Copy to clipboard'}
						</Button>
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
							className="w-full resize-none rounded-md border border-border bg-surface p-2.5 font-mono text-xs text-text-1 placeholder:text-text-2 focus:outline-none focus:ring-2 focus:ring-info-soft-fg"
						/>
					</div>
				)}

				{error && <p className="text-sm text-danger">{error}</p>}

				<Button type="submit" disabled={loading || (isUnset ? !generatedKey : !key.trim())}>
					{loading && <Loader2 className="w-4 h-4 animate-spin" />}
					{isUnset ? 'Set Key & Continue' : 'Unlock'}
				</Button>
			</form>
		</>
	);
}

interface MasterKeyGateProps {
	state: MasterKeyState;
}

/** Modal wrapper kept for callers that still want the centered overlay variant. */
export function MasterKeyGate({ state }: MasterKeyGateProps) {
	return (
		<Dialog.Root open>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-[var(--overlay)] backdrop-blur-sm" />
				<Dialog.Content className={dialogContentClassName.md}>
					<MasterKeyForm state={state} />
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

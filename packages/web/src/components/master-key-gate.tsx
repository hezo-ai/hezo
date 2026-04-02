import type { MasterKeyState } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { authenticate } from '../lib/auth';
import { queryClient } from '../lib/query-client';
import { Button } from './ui/button';
import { Input } from './ui/input';

function generateKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

interface MasterKeyGateProps {
	state: MasterKeyState;
}

export function MasterKeyGate({ state }: MasterKeyGateProps) {
	const [key, setKey] = useState('');
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	const [copied, setCopied] = useState(false);

	const isUnset = state === 'unset';

	async function handleGenerate() {
		const k = generateKey();
		setGeneratedKey(k);
		setKey(k);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!key.trim()) return;
		setError('');
		setLoading(true);
		try {
			await authenticate(key.trim());
			queryClient.invalidateQueries({ queryKey: ['status'] });
		} catch (err: unknown) {
			const apiErr = err as { message?: string };
			setError(apiErr.message || 'Invalid master key');
		} finally {
			setLoading(false);
		}
	}

	async function handleCopy() {
		await navigator.clipboard.writeText(key);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	return (
		<Dialog.Root open>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/80 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl">
					<div className="flex flex-col items-center gap-2 mb-6">
						<div className="p-3 rounded-full bg-accent-blue-bg">
							{isUnset ? (
								<KeyRound className="w-6 h-6 text-accent-blue-text" />
							) : (
								<ShieldCheck className="w-6 h-6 text-accent-blue-text" />
							)}
						</div>
						<Dialog.Title className="text-lg font-semibold text-text">
							{isUnset ? 'Set Master Key' : 'Unlock Hezo'}
						</Dialog.Title>
						<Dialog.Description className="text-sm text-text-muted text-center">
							{isUnset
								? "Create a master key to encrypt your data. Save it somewhere safe — you'll need it to unlock Hezo on restart."
								: 'Enter your master key to unlock the server.'}
						</Dialog.Description>
					</div>

					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						{isUnset && !generatedKey && (
							<Button type="button" variant="secondary" onClick={handleGenerate}>
								<KeyRound className="w-4 h-4" />
								Generate Key
							</Button>
						)}

						{generatedKey && (
							<div className="flex flex-col gap-2">
								<div className="flex items-center gap-2 rounded-md border border-border bg-bg p-2.5 font-mono text-xs break-all">
									{generatedKey}
								</div>
								<Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
									{copied ? 'Copied!' : 'Copy to clipboard'}
								</Button>
							</div>
						)}

						{!isUnset && (
							<Input
								label="Master Key"
								type="password"
								value={key}
								onChange={(e) => setKey(e.target.value)}
								placeholder="Enter master key"
								autoFocus
							/>
						)}

						{error && <p className="text-sm text-accent-red">{error}</p>}

						<Button type="submit" disabled={loading || !key.trim()}>
							{loading && <Loader2 className="w-4 h-4 animate-spin" />}
							{isUnset ? 'Set Key & Continue' : 'Unlock'}
						</Button>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

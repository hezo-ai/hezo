import { Loader2, LogIn } from 'lucide-react';
import { useState } from 'react';
import type { ApiError } from '../lib/api';
import { loginWithPassword } from '../lib/auth';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { MasterKeyForm, VaultShell } from './master-key-gate';
import { PasswordSetForm } from './password-set-form';
import { Button } from './ui/button';
import { PageLogo } from './ui/page-logo';
import { PasswordInput } from './ui/password-input';

type Mode = 'login' | 'master-key' | 'reset';

function advance() {
	queryClient.invalidateQueries({ queryKey: queryKeys.status() });
	queryClient.invalidateQueries({ queryKey: queryKeys.me() });
}

/**
 * Password sign-in for an already-active instance (normal app styling). A
 * "Forgot password?" path swaps to master-key entry (the recovery credential),
 * then a set-new-password step. The password never leaves the browser.
 */
export function PasswordLogin() {
	const [mode, setMode] = useState<Mode>('login');
	const [password, setPassword] = useState('');
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);

	async function handleLogin(e: React.FormEvent) {
		e.preventDefault();
		if (!password || loading) return;
		setError('');
		setLoading(true);
		try {
			await loginWithPassword(password);
			advance();
		} catch (err) {
			setError((err as ApiError).message || 'Incorrect password');
			setLoading(false);
		}
	}

	if (mode === 'master-key') {
		return (
			<VaultShell>
				<div
					data-testid="forgot-password-master-key"
					className="rounded-2xl border border-border-strong bg-surface p-6 sm:p-8 shadow-[var(--elev-lg)]"
				>
					<div className="mb-5 text-center">
						<h2 className="text-lg font-semibold text-text-1">Reset with your master key</h2>
						<p className="mt-1 text-sm text-text-2">
							Enter your 12-word master key to set a new admin password.
						</p>
					</div>
					<MasterKeyForm state="unlocked" embedded onAuthenticated={() => setMode('reset')} />
					<button
						type="button"
						onClick={() => setMode('login')}
						className="mt-4 w-full text-center text-[13px] text-text-2 hover:text-text-1"
					>
						Back to sign in
					</button>
				</div>
			</VaultShell>
		);
	}

	if (mode === 'reset') {
		return (
			<div className="relative min-h-screen flex items-center justify-center bg-surface px-4">
				<PageLogo />
				<div
					data-testid="reset-password"
					className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 sm:p-8 shadow-sm"
				>
					<div className="mb-5 text-center">
						<h2 className="text-lg font-semibold text-text-1">Set a new password</h2>
						<p className="mt-1 text-sm text-text-2">You'll use this to sign in from now on.</p>
					</div>
					<PasswordSetForm submitLabel="Set password & sign in" onSuccess={advance} />
				</div>
			</div>
		);
	}

	return (
		<div className="relative min-h-screen flex items-center justify-center bg-surface px-4">
			<PageLogo />
			<div
				data-testid="password-login"
				className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 sm:p-8 shadow-sm"
			>
				<div className="mb-6 flex flex-col items-center gap-2 text-center">
					<h2 className="text-lg font-semibold text-text-1">Sign in</h2>
					<p className="text-sm text-text-2">Enter your admin password to continue.</p>
				</div>
				<form onSubmit={handleLogin} className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<label htmlFor="login-password" className="text-sm font-medium text-text-1">
							Password
						</label>
						<PasswordInput
							id="login-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="current-password"
						/>
					</div>
					{error && <p className="text-sm text-danger">{error}</p>}
					<Button type="submit" disabled={loading || !password}>
						{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
						Sign in
					</Button>
				</form>
				<button
					type="button"
					onClick={() => setMode('master-key')}
					className="mt-4 w-full text-center text-[13px] text-text-2 hover:text-text-1"
				>
					Forgot password? Use your master key
				</button>
			</div>
		</div>
	);
}

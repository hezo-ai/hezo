import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ApiError } from '../lib/api';
import { MIN_PASSWORD_LENGTH, setPassword as setPasswordApi } from '../lib/auth';
import { Button } from './ui/button';
import { PasswordInput } from './ui/password-input';

interface PasswordSetFormProps {
	submitLabel: string;
	/** Called after the password is enrolled and a session is stored. */
	onSuccess: () => void;
}

/**
 * Enter + confirm a new password and enroll it. The password never leaves the
 * browser — `setPassword` derives a verifier and signs a challenge. Shared by the
 * onboarding create-password step and the forgot-password reset flow.
 */
export function PasswordSetForm({ submitLabel, onSuccess }: PasswordSetFormProps) {
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);

	const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
	const mismatch = confirm.length > 0 && confirm !== password;
	const canSubmit = password.length >= MIN_PASSWORD_LENGTH && confirm === password && !loading;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		setError('');
		setLoading(true);
		try {
			await setPasswordApi(password);
			onSuccess();
		} catch (err) {
			setError((err as ApiError).message || 'Could not set the password');
			setLoading(false);
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<label htmlFor="new-password" className="text-sm font-medium text-text-1">
					Password
				</label>
				<PasswordInput
					id="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					autoComplete="new-password"
				/>
				{tooShort && (
					<p className="text-xs text-text-2">At least {MIN_PASSWORD_LENGTH} characters.</p>
				)}
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="confirm-password" className="text-sm font-medium text-text-1">
					Confirm password
				</label>
				<PasswordInput
					id="confirm-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					autoComplete="new-password"
				/>
				{mismatch && <p className="text-xs text-danger">Passwords don't match.</p>}
			</div>
			{error && <p className="text-sm text-danger">{error}</p>}
			<Button type="submit" disabled={!canSubmit}>
				{loading && <Loader2 className="w-4 h-4 animate-spin" />}
				{submitLabel}
			</Button>
		</form>
	);
}

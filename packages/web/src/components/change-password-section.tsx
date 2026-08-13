import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ApiError } from '../lib/api';
import { changePassword, MIN_PASSWORD_LENGTH } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { PasswordInput } from './ui/password-input';

function ChangePasswordForm() {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(false);

	const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
	const mismatch = confirm.length > 0 && confirm !== next;
	const canSubmit =
		current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && confirm === next && !loading;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		setError('');
		setSaved(false);
		setLoading(true);
		try {
			await changePassword(current, next);
			setCurrent('');
			setNext('');
			setConfirm('');
			setSaved(true);
		} catch (err) {
			setError((err as ApiError).message || 'Could not change the password');
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="border border-border rounded-md p-4 bg-surface max-w-[480px]">
			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<label htmlFor="current-password" className="text-sm font-medium text-text-1">
						Current password
					</label>
					<PasswordInput
						id="current-password"
						value={current}
						onChange={(e) => setCurrent(e.target.value)}
						autoComplete="current-password"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<label htmlFor="new-password" className="text-sm font-medium text-text-1">
						New password
					</label>
					<PasswordInput
						id="new-password"
						value={next}
						onChange={(e) => setNext(e.target.value)}
						autoComplete="new-password"
					/>
					{tooShort && (
						<p className="text-xs text-text-2">At least {MIN_PASSWORD_LENGTH} characters.</p>
					)}
				</div>
				<div className="flex flex-col gap-1.5">
					<label htmlFor="confirm-password" className="text-sm font-medium text-text-1">
						Confirm new password
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
				{saved && <p className="text-sm text-success">Password updated.</p>}
				<div>
					<Button type="submit" disabled={!canSubmit}>
						{loading && <Loader2 className="w-4 h-4 animate-spin" />}
						Save
					</Button>
				</div>
			</form>
		</div>
	);
}

/**
 * Change the password you sign in with. A section of Users & access rather than
 * a page of its own: one form is not a destination, and it belongs beside the
 * list of who can sign in.
 */
export function ChangePasswordSection() {
	const { t } = useI18n();
	return (
		<section className="mb-8" data-testid="change-password-section">
			<h2 className="text-[15px] font-medium mb-1">{t('settings.adminPassword')}</h2>
			<p className="text-[13px] text-text-2 mb-3 max-w-[680px]">
				Change the password you use to sign in. Your password never leaves the browser. If you've
				forgotten it, sign out and reset it with your master key instead.
			</p>
			<ChangePasswordForm />
		</section>
	);
}

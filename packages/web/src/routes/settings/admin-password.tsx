import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { PasswordInput } from '../../components/ui/password-input';
import { useMe } from '../../hooks/use-me';
import type { ApiError } from '../../lib/api';
import { changePassword, MIN_PASSWORD_LENGTH } from '../../lib/auth';

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

function AdminPasswordPage() {
	const { data: me } = useMe();

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				The admin password is managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-5">
					<h1 className="text-[22px] font-medium">Admin password</h1>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						Change the password you use to sign in. Your password never leaves the browser. If
						you've forgotten it, sign out and reset it with your master key instead.
					</p>
				</div>
				<ChangePasswordForm />
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

export const Route = createFileRoute('/settings/admin-password')({
	component: AdminPasswordPage,
});

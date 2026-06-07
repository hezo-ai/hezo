import { Check, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useFulfillCredential } from '../../hooks/use-comments';
import { MarkdownProse } from '../markdown-prose';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'credential_request'>;
	projectId?: string;
	taskId?: string;
}

export function CredentialRequestComment({ comment, projectId, taskId }: Props) {
	const content = comment.content ?? {};
	const name = content.name ?? '';
	const kind = content.kind ?? 'other';
	const instructions = content.instructions ?? '';
	const inputType = content.input_type ?? 'text';
	const confirmationText = content.confirmation_text ?? null;
	const placeholder = content.placeholder ?? `__HEZO_SECRET_${name}__`;
	const allowedHosts = Array.isArray(content.allowed_hosts) ? content.allowed_hosts : [];
	const fulfilled = typeof comment.chosen_option?.secret_id === 'string';

	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);
	const fulfill = useFulfillCredential(projectId ?? '', taskId ?? '');

	if (!projectId || !taskId) {
		return (
			<p className="text-xs text-text-subtle italic">
				Credential request unavailable in this view.
			</p>
		);
	}

	if (fulfilled) {
		return (
			<div
				className="flex items-start gap-2 p-2.5 rounded-lg border border-accent-green bg-accent-green-bg"
				data-testid="credential-fulfilled"
			>
				<Check className="w-4 h-4 text-accent-green-text shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text">{name} provided</p>
					<p className="text-xs text-text-muted mt-0.5">
						Stored as a secret. Agent will use the placeholder{' '}
						<code className="px-1 py-0.5 rounded bg-bg-subtle">{placeholder}</code> in env vars and
						HTTP headers; the egress proxy substitutes the real value at request time.
					</p>
				</div>
			</div>
		);
	}

	const submit = () => {
		setError(null);
		const args = confirmationText
			? { commentId: comment.id, confirmed: true }
			: { commentId: comment.id, value };
		fulfill.mutate(args, {
			onError: (e: unknown) => {
				const msg = e instanceof Error ? e.message : 'Failed to submit';
				setError(msg);
			},
		});
	};

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-accent-amber bg-accent-amber-bg"
			data-testid="credential-request"
			data-credential-name={name}
		>
			<div className="flex items-start gap-2">
				<KeyRound className="w-4 h-4 text-accent-amber-text shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text">
						Agent needs credential: <code className="px-1 py-0.5 rounded bg-bg-subtle">{name}</code>{' '}
						<Badge className="ml-1">{kind}</Badge>
					</p>
					{instructions && (
						<div className="mt-1.5 text-sm text-text">
							<MarkdownProse>{instructions}</MarkdownProse>
						</div>
					)}
					{allowedHosts.length > 0 && (
						<p className="text-xs text-text-muted mt-1">
							Substituted only into requests to: {allowedHosts.join(', ')}
						</p>
					)}
				</div>
			</div>

			{confirmationText ? (
				<div className="flex flex-col gap-2">
					<p className="text-sm text-text">{confirmationText}</p>
					<div>
						<Button
							size="sm"
							onClick={submit}
							disabled={fulfill.isPending}
							data-testid="credential-confirm"
						>
							{fulfill.isPending ? 'Submitting…' : 'Confirm'}
						</Button>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{inputType === 'textarea' ? (
						<textarea
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="Paste value here"
							rows={6}
							className="w-full font-mono text-xs p-2 rounded border border-border bg-bg focus:outline-none focus:border-accent-blue"
							data-testid="credential-input"
						/>
					) : inputType === 'file' ? (
						<input
							type="file"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (!file) return;
								file.text().then(setValue);
							}}
							className="text-sm"
							data-testid="credential-input"
						/>
					) : (
						<input
							type="password"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="Paste value here"
							autoComplete="off"
							className="w-full text-sm p-2 rounded border border-border bg-bg focus:outline-none focus:border-accent-blue"
							data-testid="credential-input"
						/>
					)}
					{error && <p className="text-xs text-accent-red-text">{error}</p>}
					<div>
						<Button
							size="sm"
							onClick={submit}
							disabled={fulfill.isPending || value.length === 0}
							data-testid="credential-submit"
						>
							{fulfill.isPending ? 'Storing…' : 'Provide credential'}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

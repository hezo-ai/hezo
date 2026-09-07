import { suggestAllowedHosts } from '@hezo/shared';
import { Check, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useFulfillCredential } from '../../hooks/use-comments';
import { MarkdownProse } from '../markdown-prose';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
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

	// When the agent didn't scope the request, pre-fill the field with a
	// best-guess allowlist inferred from the credential name and instructions
	// (curated service hosts + any URL the agent named). It's only a suggestion —
	// the human reviews and can edit or clear it before the secret is stored.
	const suggestedHosts =
		allowedHosts.length === 0 ? suggestAllowedHosts({ name, instructions }) : [];

	const [value, setValue] = useState('');
	const [hostsInput, setHostsInput] = useState(
		allowedHosts.length > 0 ? allowedHosts.join(', ') : suggestedHosts.join(', '),
	);
	const [hostsEdited, setHostsEdited] = useState(false);
	// The agent may request body substitution; the human approves or declines it
	// here. Pre-checked when requested, but freely unchecked before storing.
	const [allowBodySubstitution, setAllowBodySubstitution] = useState(
		content.allow_body_substitution === true,
	);
	const [error, setError] = useState<string | null>(null);
	const showSuggestionHint = !hostsEdited && suggestedHosts.length > 0 && hostsInput.length > 0;
	const fulfill = useFulfillCredential(projectId ?? '', taskId ?? '');

	const parseHosts = (raw: string): string[] =>
		raw
			.split(/[\s,]+/)
			.map((h) => h.trim().toLowerCase())
			.filter((h) => h.length > 0);

	if (!projectId || !taskId) {
		return (
			<p className="text-xs text-text-3 italic">Credential request unavailable in this view.</p>
		);
	}

	if (fulfilled) {
		return (
			// `role="none"`: a thread renders many of these at once, and the thread is
			// what a reader follows - one live region per card is noise.
			<Callout
				tone="success"
				role="none"
				className="border border-success"
				icon={<Check className="w-4 h-4" />}
				data-testid="credential-fulfilled"
			>
				<div>
					<p className="text-sm font-medium text-text-1">{name} provided</p>
					<p className="text-xs text-text-2 mt-0.5">
						Stored as a secret. Agent will use the placeholder{' '}
						<code className="px-1 py-0.5 rounded bg-surface-2">{placeholder}</code> in env vars and
						HTTP headers; the egress proxy substitutes the real value at request time.
					</p>
				</div>
			</Callout>
		);
	}

	const submit = () => {
		setError(null);
		const args = confirmationText
			? { commentId: comment.id, confirmed: true }
			: {
					commentId: comment.id,
					value,
					allowedHosts: parseHosts(hostsInput),
					allowBodySubstitution,
				};
		fulfill.mutate(args, {
			onError: (e: unknown) => {
				const msg = e instanceof Error ? e.message : 'Failed to submit';
				setError(msg);
			},
		});
	};

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-warning bg-warning-soft"
			data-testid="credential-request"
			data-credential-name={name}
		>
			<div className="flex items-start gap-2">
				<KeyRound className="w-4 h-4 text-warning-soft-fg shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text-1">
						Agent needs credential: <code className="px-1 py-0.5 rounded bg-surface-2">{name}</code>{' '}
						<Badge className="ml-1">{kind}</Badge>
					</p>
					{instructions && (
						<div className="mt-1.5 text-sm text-text-1">
							<MarkdownProse>{instructions}</MarkdownProse>
						</div>
					)}
					{allowedHosts.length > 0 ? (
						<p className="text-xs text-text-2 mt-1">
							Substituted only into requests to: {allowedHosts.join(', ')}
						</p>
					) : (
						!confirmationText && (
							<p
								className="text-xs text-warning-soft-fg mt-1"
								data-testid="credential-no-hosts-warning"
							>
								⚠ Not scoped to any host - this credential won't be substituted into any request
								until an allowlist is set.
							</p>
						)
					)}
				</div>
			</div>

			{confirmationText ? (
				<div className="flex flex-col gap-2">
					<p className="text-sm text-text-1">{confirmationText}</p>
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
							className="w-full font-mono text-xs p-2 rounded border border-border bg-surface focus:outline-none focus:border-info"
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
							className="w-full text-sm p-2 rounded border border-border bg-surface focus:outline-none focus:border-info"
							data-testid="credential-input"
						/>
					)}
					<div className="flex flex-col gap-1">
						<label htmlFor={`hosts-${comment.id}`} className="text-xs text-text-2">
							Allowed hosts - the API host(s) this value may be sent to (comma-separated). The
							egress proxy substitutes it only for these hosts.
						</label>
						<input
							id={`hosts-${comment.id}`}
							type="text"
							value={hostsInput}
							onChange={(e) => {
								setHostsInput(e.target.value);
								setHostsEdited(true);
							}}
							placeholder="e.g. api.netlify.com, *.netlify.com"
							autoComplete="off"
							className="w-full text-sm p-2 rounded border border-border bg-surface focus:outline-none focus:border-info"
							data-testid="credential-hosts-input"
						/>
						{showSuggestionHint && (
							<p className="text-xs text-text-3" data-testid="credential-hosts-suggested">
								Suggested from the request - review and edit if these aren't right.
							</p>
						)}
					</div>
					<label className="flex items-start gap-2 text-xs text-text-2">
						<input
							type="checkbox"
							checked={allowBodySubstitution}
							onChange={(e) => setAllowBodySubstitution(e.target.checked)}
							className="mt-0.5"
							data-testid="credential-body-substitution"
						/>
						<span>
							Allow substitution into small JSON request bodies (e.g. an API login that takes the
							credential in the body). Leave off unless an API requires it.
						</span>
					</label>
					{error && <p className="text-xs text-danger-soft-fg">{error}</p>}
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

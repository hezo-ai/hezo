import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { DialogContent } from '../ui/dialog';
import { buildReviewHandoff } from './review-handoff';

interface ActionReviewDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	filename: string;
	commentCount: number;
}

/**
 * "Action this review": hands the pending review to an agent. Shows the
 * admin-facing instructions and the copyable handoff blurb — the comments
 * themselves stay in the database (agents read them via read_project_doc).
 */
export function ActionReviewDialog({
	open,
	onOpenChange,
	filename,
	commentCount,
}: ActionReviewDialogProps) {
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const handoff = buildReviewHandoff(filename);

	async function handleCopy() {
		const ok = await copyToClipboard(handoff);
		if (!ok) return;
		setCopied(true);
		clearTimeout(copiedTimer.current);
		copiedTimer.current = setTimeout(() => setCopied(false), 1500);
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md" data-testid="action-review-dialog">
				<Dialog.Title className="mb-3 pr-8 text-base font-semibold">
					Action this review
				</Dialog.Title>
				<Dialog.Description className="mb-3 text-[12.5px] leading-relaxed text-text-2">
					Paste this handoff into a task comment — or a new task's description — and assign it to
					the agent who should action the feedback. The agent reads the review comments directly
					from the document.
				</Dialog.Description>
				<div
					className="whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed text-text-1"
					data-testid="action-review-handoff"
				>
					{handoff}
				</div>
				<div className="mt-4 flex items-center justify-between gap-2">
					<span className="text-xs text-text-3">
						{commentCount} comment{commentCount === 1 ? '' : 's'} · {filename}
					</span>
					<button
						type="button"
						onClick={handleCopy}
						aria-label={copied ? 'Copied' : 'Copy handoff'}
						data-testid="action-review-copy"
						className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-sm border border-transparent bg-inverse px-2.5 text-[12.5px] font-medium text-inverse-fg hover:opacity-90"
					>
						{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

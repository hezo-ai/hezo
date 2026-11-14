import { ApprovalStatus, RoleUpdateOutcome } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronsUpDown, Loader2, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Approval, useApprovalDetail, useResolveApproval } from '../hooks/use-approvals';
import { Trans, useI18n } from '../lib/i18n';
import { computeLineDiff, type DiffLine, type DiffLineKind, foldUnchanged } from '../lib/line-diff';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Callout } from './ui/callout';
import { DialogContent } from './ui/dialog';

/** How each kind of line is drawn: its tint, its sign, and what a screen reader hears. */
const LINE_STYLE: Record<
	DiffLineKind,
	{ row: string; mark: string; sign: string; spoken: 'added' | 'removed' | null }
> = {
	context: { row: '', mark: 'text-text-2', sign: '', spoken: null },
	added: { row: 'bg-success-soft', mark: 'text-success-soft-fg', sign: '+', spoken: 'added' },
	removed: { row: 'bg-danger-soft', mark: 'text-danger-soft-fg', sign: '-', spoken: 'removed' },
};

/** The agent a role update card names, by its title, else its slug. */
export function roleUpdateAgentName(payload: Record<string, unknown>): string {
	return (payload.agent_title as string) ?? (payload.agent_slug as string) ?? '';
}

function DiffRow({ line, editedTag }: { line: DiffLine; editedTag: string | null }) {
	const { t } = useI18n();
	const style = LINE_STYLE[line.kind];
	return (
		<div
			className={`grid grid-cols-[2.25rem_1rem_minmax(0,1fr)] sm:grid-cols-[2.75rem_2.75rem_1.25rem_minmax(0,1fr)] ${style.row}`}
			data-testid={`diff-line-${line.kind}`}
		>
			<span className={`hidden sm:block text-right pr-2.5 text-[11px] ${style.mark}`}>
				{line.oldNo ?? ''}
			</span>
			<span className={`text-right pr-1.5 sm:pr-2.5 text-[11px] ${style.mark}`}>
				{line.newNo ?? line.oldNo ?? ''}
			</span>
			<span className={`text-center ${style.mark}`} aria-hidden="true">
				{style.sign}
			</span>
			<span className="whitespace-pre-wrap break-words pr-3 min-h-5">
				{style.spoken && (
					<span className="sr-only">
						{t(
							style.spoken === 'added'
								? 'approval.roleUpdate.dialog.srAdded'
								: 'approval.roleUpdate.dialog.srRemoved',
						)}
						:{' '}
					</span>
				)}
				{line.text}
				{editedTag && (
					<span className="ml-2 inline-flex items-center h-[18px] px-1.5 rounded-sm bg-warning-soft text-warning-soft-fg font-sans text-[11px] font-medium align-[1px]">
						{editedTag}
					</span>
				)}
			</span>
		</div>
	);
}

interface RoleUpdatePreviewDialogProps {
	approval: Approval;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The only place a role update is decided. It shows the agent's live prompt
 * against the text accepting would write, and the two answers sit under the
 * diff so nobody accepts a text they have not been shown. When the role was
 * edited here, the admin's own lines that accepting drops carry a tag.
 */
export function RoleUpdatePreviewDialog({
	approval,
	open,
	onOpenChange,
}: RoleUpdatePreviewDialogProps) {
	const { t } = useI18n();
	const who = roleUpdateAgentName(approval.payload);
	const detail = useApprovalDetail(approval.id, open);
	// Once loaded, the warning follows the live prompt: an edit made after the card
	// was filed is lost on Apply too. Until then, the card's own verdict stands.
	const lostLines = detail.data?.lost_lines ?? null;
	const edited =
		lostLines !== null
			? lostLines.length > 0
			: approval.payload.outcome === RoleUpdateOutcome.Conflict;
	const resolve = useResolveApproval();
	const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(new Set());

	const offered = detail.data?.payload.content;
	const current = detail.data?.current_prompt;
	const ready = typeof offered === 'string' && typeof current === 'string';
	const diff = useMemo(
		() => (ready ? computeLineDiff(current as string, offered as string) : null),
		[ready, current, offered],
	);
	const items = useMemo(() => (diff ? foldUnchanged(diff.lines) : []), [diff]);
	// `lost_lines` names one entry per lost occurrence, so a line the role also
	// has once is tagged once: each removed line takes a tag while its text has
	// one left.
	const taggedLines = useMemo(() => {
		const left = new Map<string, number>();
		for (const line of lostLines ?? []) left.set(line, (left.get(line) ?? 0) + 1);
		const tagged = new Set<number>();
		for (const line of diff?.lines ?? []) {
			const n = line.kind === 'removed' && line.oldNo !== null ? (left.get(line.text) ?? 0) : 0;
			if (n > 0 && line.oldNo !== null) {
				tagged.add(line.oldNo);
				left.set(line.text, n - 1);
			}
		}
		return tagged;
	}, [lostLines, diff]);
	const editedTag = t('approval.roleUpdate.dialog.editedTag');
	const editedCount = taggedLines.size;

	const [promptMoved, setPromptMoved] = useState(false);
	const [checking, setChecking] = useState(false);

	/**
	 * Apply writes the card's text over whatever the prompt holds, so the prompt is
	 * read again first. If it changed since this window showed it, the fresh read
	 * redraws the diff and the warning, and the admin decides again on what is
	 * actually there.
	 */
	async function applyChecked() {
		const shown = current;
		setChecking(true);
		const fresh = await detail.refetch();
		setChecking(false);
		if (fresh.isError) return;
		if (fresh.data?.current_prompt !== shown) {
			setPromptMoved(true);
			return;
		}
		decide(ApprovalStatus.Approved);
	}

	function decide(status: typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied) {
		resolve.mutate(
			{
				approvalId: approval.id,
				status,
				projectSlug: approval.payload_project_slug ?? undefined,
			},
			{ onSuccess: () => onOpenChange(false) },
		);
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="2xl" data-testid="role-update-preview">
				<div className="flex flex-col gap-4 min-h-0">
					<div className="flex flex-col gap-1.5 pr-8">
						<Dialog.Title className="text-lg font-semibold">
							{t('approval.roleUpdate.dialog.title', { who })}
						</Dialog.Title>
						<Dialog.Description className="text-sm text-text-2">
							{t(
								edited ? 'approval.roleUpdate.dialog.edited' : 'approval.roleUpdate.dialog.clean',
								{ who },
							)}
						</Dialog.Description>
					</div>

					{edited && (
						<Callout
							tone="warning"
							role="none"
							icon={<TriangleAlert className="size-4" />}
							title={t('approval.roleUpdate.dialog.warningTitle')}
						>
							<Trans
								k="approval.roleUpdate.dialog.warningBody"
								vars={{
									tag: editedTag,
									keep: <span className="font-medium">{t('approval.roleUpdate.dialog.keep')}</span>,
								}}
							/>
						</Callout>
					)}

					{promptMoved && (
						<Callout tone="info" role="status">
							{t('approval.roleUpdate.dialog.promptMoved', { who })}
						</Callout>
					)}

					{detail.isError && (
						<Callout tone="danger" role="alert">
							{t('approval.roleUpdate.dialog.loadFailed')}
						</Callout>
					)}

					{!diff && !detail.isError && (
						<div className="flex items-center gap-2 text-sm text-text-2 py-6">
							<Loader2 className="size-4 animate-spin" />
							{t('common.loading')}
						</div>
					)}

					{diff && (
						<>
							<div className="flex items-center gap-2 flex-wrap">
								<Badge color="success">
									{t('approval.roleUpdate.dialog.linesAdded', { count: diff.added })}
								</Badge>
								<Badge color="danger">
									{t('approval.roleUpdate.dialog.linesRemoved', { count: diff.removed })}
								</Badge>
								{editedCount > 0 && (
									<Badge color="warning">
										{t('approval.roleUpdate.dialog.editedCount', { count: editedCount })}
									</Badge>
								)}
								<span className="text-xs text-text-2 sm:ml-1">
									{t('approval.roleUpdate.dialog.foldHint')}
								</span>
							</div>
							<section
								aria-label={t('approval.roleUpdate.dialog.diffLabel', { who })}
								className="border border-border rounded-md overflow-y-auto sm:max-h-[min(460px,50dvh)] font-mono text-xs leading-5 bg-surface"
								data-testid="role-update-diff"
							>
								{items.map((item) => {
									if (item.kind !== 'fold') {
										return (
											<DiffRow
												key={`${item.oldNo}-${item.newNo}`}
												line={item}
												editedTag={
													item.oldNo !== null && taggedLines.has(item.oldNo) ? editedTag : null
												}
											/>
										);
									}
									if (openFolds.has(item.id)) {
										return item.lines.map((line) => (
											<DiffRow key={`${line.oldNo}-${line.newNo}`} line={line} editedTag={null} />
										));
									}
									return (
										<button
											key={`fold-${item.id}`}
											type="button"
											className="flex items-center gap-2 w-full min-h-8 [html[data-density=touch]_&]:min-h-11 pl-3 sm:pl-[1.125rem] border-y border-border first:border-t-0 last:border-b-0 bg-surface-2 text-text-2 font-sans text-xs font-medium text-left hover:bg-surface-3"
											onClick={() => setOpenFolds((prev) => new Set(prev).add(item.id))}
										>
											<ChevronsUpDown className="size-3.5" />
											{t('approval.roleUpdate.dialog.fold', { count: item.lines.length })}
										</button>
									);
								})}
							</section>
						</>
					)}

					<div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
						<p className="text-xs text-text-2 sm:flex-1 m-0">
							{t('approval.roleUpdate.dialog.undo', { who })}
						</p>
						<div className="flex flex-col-reverse sm:flex-row gap-2">
							<Button
								variant="secondary"
								disabled={resolve.isPending}
								data-testid="role-update-keep"
								onClick={() => decide(ApprovalStatus.Denied)}
							>
								{t('approval.roleUpdate.dialog.keep')}
							</Button>
							<Button
								variant="primary"
								disabled={resolve.isPending || checking || !diff}
								data-testid="role-update-apply"
								onClick={() => {
									void applyChecked();
								}}
							>
								{resolve.isPending || checking ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Check className="size-3.5" />
								)}
								{t('approval.roleUpdate.dialog.apply')}
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

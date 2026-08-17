import * as Popover from '@radix-ui/react-popover';
import { Smile } from 'lucide-react';
import { useState } from 'react';
import { type ReactionGroup, useAddReaction, useRemoveReaction } from '../../hooks/use-comments';
import { Tooltip } from '../ui/tooltip';
import type { CommentData } from './comment-data';
import { AVAILABLE_REACTION_KINDS, REACTION_GLYPH, REACTION_LABEL } from './helpers';

function reactorName(m: { slug: string | null; display_name: string | null }): string {
	if (m.slug) return `@${m.slug}`;
	return m.display_name ?? 'someone';
}

function reactorsTooltip(group: ReactionGroup): string {
	const names = group.members.map(reactorName);
	if (names.length === 0) return REACTION_LABEL[group.kind] ?? group.kind;
	return `${REACTION_LABEL[group.kind] ?? group.kind} · ${names.join(', ')}`;
}

interface Props {
	comment: CommentData;
	projectId?: string;
	taskId?: string;
}

export function CommentReactions({ comment, projectId, taskId }: Props) {
	const groups = comment.reactions ?? [];
	const [pickerOpen, setPickerOpen] = useState(false);
	const addReaction = useAddReaction(projectId ?? '', taskId ?? '');
	const removeReaction = useRemoveReaction(projectId ?? '', taskId ?? '');

	if (!projectId || !taskId) return null;
	const busy = addReaction.isPending || removeReaction.isPending;

	const toggle = (kind: string, youReacted: boolean) => {
		if (busy) return;
		if (youReacted) removeReaction.mutate({ commentId: comment.id, kind });
		else addReaction.mutate({ commentId: comment.id, kind });
	};

	const availableToAdd = AVAILABLE_REACTION_KINDS.filter(
		(k) => !groups.some((g) => g.kind === k && g.you_reacted),
	);

	if (groups.length === 0 && availableToAdd.length === 0) return null;

	return (
		<div className="flex flex-wrap items-center gap-1.5 mt-2" data-testid="comment-reactions">
			{groups.map((g) => (
				<Tooltip key={g.kind} content={reactorsTooltip(g)}>
					<button
						type="button"
						onClick={() => toggle(g.kind, g.you_reacted)}
						disabled={busy}
						aria-pressed={g.you_reacted}
						data-reaction-kind={g.kind}
						data-you-reacted={g.you_reacted ? 'true' : 'false'}
						className={`inline-flex items-center gap-1 min-h-[28px] px-2 rounded-full border text-xs leading-none transition-colors ${
							g.you_reacted
								? 'border-info bg-info-soft text-info-soft-fg'
								: 'border-border bg-surface-2 text-text-2 hover:border-border-strong'
						} disabled:opacity-60`}
					>
						<span aria-hidden="true">{REACTION_GLYPH[g.kind] ?? g.kind}</span>
						<span className="tabular-nums">{g.members.length}</span>
					</button>
				</Tooltip>
			))}
			{availableToAdd.length > 0 && (
				<Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
					<Popover.Trigger asChild>
						<button
							type="button"
							disabled={busy}
							aria-label="Add reaction"
							data-testid="add-reaction-button"
							className="inline-flex items-center justify-center min-w-[28px] min-h-[28px] px-1.5 rounded-full border border-border text-text-2 hover:text-text-1 hover:border-border-strong disabled:opacity-60"
						>
							<Smile className="w-3.5 h-3.5" />
						</button>
					</Popover.Trigger>
					{/* Portal + z-50 so the picker escapes the comment card's
					    `overflow-hidden` and the Virtuoso row's stacking context -
					    an in-flow `absolute` popup was clipped and painted under the
					    next comment. Radix flips it above the trigger near the
					    viewport's bottom edge. */}
					<Popover.Portal>
						<Popover.Content
							align="start"
							side="bottom"
							sideOffset={4}
							className="z-50 flex gap-1 rounded-md border border-border bg-surface p-1 shadow-md"
							data-testid="reaction-picker"
						>
							{availableToAdd.map((kind) => (
								<Tooltip key={kind} content={REACTION_LABEL[kind] ?? kind}>
									<button
										type="button"
										onClick={() => {
											setPickerOpen(false);
											toggle(kind, false);
										}}
										aria-label={REACTION_LABEL[kind] ?? kind}
										className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] px-2 rounded text-sm hover:bg-surface-2"
										data-reaction-kind={kind}
									>
										{REACTION_GLYPH[kind] ?? kind}
									</button>
								</Tooltip>
							))}
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			)}
		</div>
	);
}

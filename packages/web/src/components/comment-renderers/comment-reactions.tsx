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
	teamId?: string;
	taskId?: string;
}

export function CommentReactions({ comment, teamId, taskId }: Props) {
	const groups = comment.reactions ?? [];
	const [pickerOpen, setPickerOpen] = useState(false);
	const addReaction = useAddReaction(teamId ?? '', taskId ?? '');
	const removeReaction = useRemoveReaction(teamId ?? '', taskId ?? '');

	if (!teamId || !taskId) return null;
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
								? 'border-accent-blue bg-accent-blue-bg text-accent-blue-text'
								: 'border-border bg-bg-subtle text-text-muted hover:border-border-hover'
						} disabled:opacity-60`}
					>
						<span aria-hidden="true">{REACTION_GLYPH[g.kind] ?? g.kind}</span>
						<span className="tabular-nums">{g.members.length}</span>
					</button>
				</Tooltip>
			))}
			{availableToAdd.length > 0 && (
				<div className="relative">
					<button
						type="button"
						onClick={() => setPickerOpen((open) => !open)}
						disabled={busy}
						aria-label="Add reaction"
						data-testid="add-reaction-button"
						className="inline-flex items-center justify-center min-w-[28px] min-h-[28px] px-1.5 rounded-full border border-border text-text-muted hover:text-text hover:border-border-hover disabled:opacity-60"
					>
						<Smile className="w-3.5 h-3.5" />
					</button>
					{pickerOpen && (
						<div
							className="absolute z-10 mt-1 flex gap-1 rounded-md border border-border bg-bg-elevated p-1 shadow-md"
							role="menu"
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
										className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] px-2 rounded text-sm hover:bg-bg-subtle"
										data-reaction-kind={kind}
									>
										{REACTION_GLYPH[kind] ?? kind}
									</button>
								</Tooltip>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

import { Check } from 'lucide-react';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'options'>;
	onChoose?: (commentId: string, chosenId: string) => void;
}

export function OptionsComment({ comment, onChoose }: Props) {
	const prompt = comment.content?.prompt ?? '';
	const options = comment.content?.options ?? [];
	const chosenId = comment.chosen_option?.chosen_id ?? null;

	return (
		<div>
			{prompt && <p className="text-sm text-text-1 mb-2">{prompt}</p>}
			<div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
				{options.map((opt) => {
					const isChosen = chosenId === opt.id;
					const isOther = chosenId && !isChosen;
					return (
						<button
							key={opt.id}
							type="button"
							disabled={!!chosenId}
							onClick={() => onChoose?.(comment.id, opt.id)}
							className={`text-left p-2.5 rounded-lg border transition-colors ${
								isChosen
									? 'border-info bg-info-soft'
									: isOther
										? 'border-border bg-surface-2 opacity-50'
										: 'border-border hover:border-border-strong cursor-pointer'
							}`}
						>
							<div className="flex items-center gap-1.5">
								{isChosen && <Check className="w-3.5 h-3.5 text-info-soft-fg shrink-0" />}
								<span className="text-sm font-medium text-text-1">{opt.label}</span>
							</div>
							{opt.description && <p className="text-xs text-text-2 mt-0.5">{opt.description}</p>}
						</button>
					);
				})}
			</div>
		</div>
	);
}

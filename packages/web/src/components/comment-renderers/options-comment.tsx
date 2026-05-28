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
			{prompt && <p className="text-sm text-text mb-2">{prompt}</p>}
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
									? 'border-accent-blue bg-accent-blue-bg'
									: isOther
										? 'border-border bg-bg-subtle opacity-50'
										: 'border-border hover:border-border-hover cursor-pointer'
							}`}
						>
							<div className="flex items-center gap-1.5">
								{isChosen && <Check className="w-3.5 h-3.5 text-accent-blue-text shrink-0" />}
								<span className="text-sm font-medium text-text">{opt.label}</span>
							</div>
							{opt.description && (
								<p className="text-xs text-text-muted mt-0.5">{opt.description}</p>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

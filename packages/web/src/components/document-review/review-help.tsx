import { TriangleAlert } from 'lucide-react';
import { HelpDialog } from '../ui/help-dialog';

/**
 * The bare "?" help affordance shown next to the review toolbar. Explains the
 * review-comment system — most importantly that any update to the reviewed
 * file deletes all existing review comments. The `subject` flavors the copy:
 * documents and text assets take anchored comments; other asset types take
 * whole-asset comments from the review panel.
 */
export function ReviewHelp({
	className,
	subject = 'document',
}: {
	className?: string;
	subject?: 'document' | 'asset';
}) {
	const isAsset = subject === 'asset';
	return (
		<HelpDialog
			title={isAsset ? 'How asset review works' : 'How document review works'}
			triggerLabel="How review comments work"
			variant="glyph"
			className={className}
			data-testid="review-help"
		>
			<ul className="list-disc space-y-2 pl-4 text-[12.5px] leading-relaxed text-text-1">
				{isAsset ? (
					<li>
						On a <strong>text asset</strong> (markdown, plain text),{' '}
						<strong>select any text</strong> or <strong>hover a line</strong> to leave an anchored
						comment — exactly like a document. Other asset types (images, HTML, PDFs, …) take{' '}
						<strong>whole-asset comments</strong> from the review panel.
					</li>
				) : (
					<>
						<li>
							<strong>Select any text</strong> in the document to leave a comment on it — the text
							stays highlighted.
						</li>
						<li>
							<strong>Hover a line</strong> and click the comment icon that appears in the right
							margin to comment on the whole line.
						</li>
					</>
				)}
				<li>
					<strong>Click a highlight</strong> (or its margin icon) to edit or delete that comment.
				</li>
				<li>
					The <strong>clipboard button</strong> opens a handoff you can copy — or post straight onto
					a task you pick from the <strong>Add to task</strong> list — agents read the comments
					directly from the {isAsset ? 'asset' : 'document'}.
				</li>
				<li>
					The <strong>trash button</strong> clears the entire review.
				</li>
			</ul>
			<div className="mt-4 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-[12.5px] leading-relaxed text-warning-soft-fg">
				<TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span>
					{isAsset
						? 'Any write to the asset — by you or an agent — automatically deletes all existing review comments. A review applies to the current version of the asset only.'
						: 'Any update to the document — by you or an agent — automatically deletes all existing review comments. A review applies to the current version of the document only.'}
				</span>
			</div>
		</HelpDialog>
	);
}

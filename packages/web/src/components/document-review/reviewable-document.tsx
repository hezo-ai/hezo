import { useCallback, useState } from 'react';
import {
	useCreateDocReviewComment,
	useDeleteDocReviewComment,
	useDocReviewComments,
	useUpdateDocReviewComment,
} from '../../hooks/use-doc-review';
import type { ReviewAnchor } from '../../lib/doc-review-selection';
import type { ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { MarkdownProse } from '../markdown-prose';
import { ReviewSurface } from './review-surface';

interface ReviewableDocumentProps {
	/** Route-param project slug (query keys + API paths). */
	projectId: string;
	projectSlug: string;
	filename: string;
	content: string;
	/** The document `updated_at` this view rendered — guards stale creates. */
	docUpdatedAt?: string;
}

/**
 * A project document rendered in view mode with review-comment support — the
 * doc-flavored wrapper over `ReviewSurface` (which owns the selection pill,
 * hover-line ghost, margin icons, and editor). Comments are DB-backed and
 * version-scoped: any edit to the document wipes them (see the ? help).
 */
export function ReviewableDocument({
	projectId,
	projectSlug,
	filename,
	content,
	docUpdatedAt,
}: ReviewableDocumentProps) {
	const { data: comments } = useDocReviewComments(projectId, filename);
	const create = useCreateDocReviewComment(projectId, filename);
	const update = useUpdateDocReviewComment(projectId, filename);
	const remove = useDeleteDocReviewComment(projectId, filename);
	const [activeId, setActiveId] = useState<string | null>(null);

	const { mutateAsync: createAsync } = create;
	const handleCreate = useCallback(
		async (anchor: ReviewAnchor, text: string) => {
			await createAsync({
				quote: anchor.quote,
				occurrence: anchor.occurrence,
				comment: text,
				docUpdatedAt,
			});
		},
		[createAsync, docUpdatedAt],
	);
	const { mutate: updateMutate } = update;
	const handleUpdate = useCallback(
		(commentId: string, text: string) => updateMutate({ commentId, comment: text }),
		[updateMutate],
	);
	const { mutate: removeMutate } = remove;
	const handleDelete = useCallback(
		(commentId: string) => removeMutate({ commentId }),
		[removeMutate],
	);

	// Referential stability matters: ReviewSurface memoizes the rendered prose
	// on this callback so its hover/selection churn never re-runs markdown.
	const renderContent = useCallback(
		(
			annotations: ReviewAnnotation[],
			onHighlightClick: (id: string) => void,
			active: string | null,
		) => (
			<MarkdownProse
				projectId={projectId}
				projectSlug={projectSlug}
				reviewAnnotations={annotations}
				onReviewHighlightClick={onHighlightClick}
				activeReviewId={active}
			>
				{content}
			</MarkdownProse>
		),
		[projectId, projectSlug, content],
	);

	return (
		<ReviewSurface
			comments={comments}
			saving={create.isPending}
			activeId={activeId}
			onActiveIdChange={setActiveId}
			onCreate={handleCreate}
			onUpdate={handleUpdate}
			onDelete={handleDelete}
			renderContent={renderContent}
		/>
	);
}

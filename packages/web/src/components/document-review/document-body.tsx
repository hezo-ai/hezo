import { type ReactNode, useMemo } from 'react';
import { stripLeadingMetadataBlock } from '../../lib/doc-metadata-strip';
import { MarkdownProse } from '../markdown-prose';
import { type DocMetadata, DocumentMetadataBanner } from './document-metadata-banner';
import { ReviewableDocument } from './reviewable-document';

interface DocumentBodyProps {
	content: string;
	projectId?: string;
	projectSlug?: string;
	/** Metadata banner facts (created/updated/last editor). Omit to hide the banner. */
	meta?: DocMetadata;
	/**
	 * Review-comment support (view of the latest version only). Pass `null`/omit to
	 * render the body plainly — used when viewing an older revision, where review
	 * comments don't apply.
	 */
	review?: { filename: string; docUpdatedAt?: string } | null;
	/** Rendered above the metadata banner — e.g. the "viewing revision N" banner. */
	topSlot?: ReactNode;
}

/**
 * The shared project-doc body renderer used by every doc surface (Documents tab,
 * pop-out preview, task-sidebar preview). It strips any legacy leading metadata
 * block for display, renders the structured metadata banner above the body, and
 * renders the body itself with review-comment support when `review` is set. The
 * banner + top slot sit OUTSIDE `ReviewableDocument` so its review anchoring only
 * ever sees the document body.
 */
export function DocumentBody({
	content,
	projectId,
	projectSlug,
	meta,
	review,
	topSlot,
}: DocumentBodyProps) {
	const body = useMemo(() => stripLeadingMetadataBlock(content), [content]);
	return (
		<div>
			{topSlot}
			{meta && <DocumentMetadataBanner {...meta} />}
			{review && projectId && projectSlug ? (
				<ReviewableDocument
					projectId={projectId}
					projectSlug={projectSlug}
					filename={review.filename}
					content={body}
					docUpdatedAt={review.docUpdatedAt}
				/>
			) : (
				<MarkdownProse projectId={projectId} projectSlug={projectSlug}>
					{body}
				</MarkdownProse>
			)}
		</div>
	);
}

/**
 * The copyable agent handoff produced by the "Action this review" dialog. The
 * admin pastes it into a task comment (or a new task's description) and
 * assigns the agent; the review comments themselves travel via the database —
 * `read_project_doc` returns them alongside the content — so the blurb only
 * has to point the agent at the document and spell out the lifecycle rules.
 */
export function buildReviewHandoff(filename: string): string {
	return [
		`Review comments have been left on the document ${filename}.`,
		`Read it with read_project_doc — the pending review comments come back alongside the content, each anchoring a comment to an exact quote from the document.`,
		`IMPORTANT: capture ALL review comments before your first write. Any update to the document automatically deletes every review comment on it, so keep them in context and make one consolidated update rather than multiple passes (documents are revisioned — one clean revision also beats a trail of partial ones).`,
		`Action each comment and update the document accordingly. If any feedback is unclear or you are unsure how to proceed, ask the admin in the task thread before making changes.`,
	].join('\n\n');
}

/** The asset flavor: same lifecycle rules, read/write via the asset tools. */
export function buildAssetReviewHandoff(path: string): string {
	return [
		`Review comments have been left on the asset assets/${path}.`,
		`Read it with read_project_asset — the pending review comments come back alongside the content. On a text asset each comment anchors to an exact quote; a comment without a quote applies to the whole file.`,
		`IMPORTANT: capture ALL review comments before your first write. Any write_project_asset to this path automatically deletes every review comment on it, so keep them in context and make one consolidated update rather than multiple passes.`,
		`Action each comment and update the asset accordingly. If any feedback is unclear or you are unsure how to proceed, ask the admin in the task thread before making changes.`,
	].join('\n\n');
}

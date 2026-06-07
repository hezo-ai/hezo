// Builds the path to the chrome-less standalone preview of a project document,
// opened in a new tab from the document viewer and from doc mentions in comments.
export function docPreviewPath(projectSlug: string, filename: string): string {
	return `/preview/${encodeURIComponent(projectSlug)}/${encodeURIComponent(filename)}`;
}

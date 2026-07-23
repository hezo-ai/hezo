/**
 * Trigger a client-side download of in-memory text as a file. Builds a Blob and
 * clicks a transient `<a download>` — no server round-trip, since the document
 * content is already loaded in the viewer. The object URL is revoked on the next
 * tick, once the click has initiated the download.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
	const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = 'noopener';
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Copy text to the clipboard, working in both secure and insecure contexts.
 *
 * The async Clipboard API is only available in secure contexts (HTTPS or
 * localhost). When the UI is served over plain HTTP on a remote host
 * `navigator.clipboard` is undefined, so fall back to a hidden textarea and the
 * legacy copy command. Never throws — resolves to whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to the legacy path below.
		}
	}

	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	const textarea = document.createElement('textarea');
	textarea.value = text;
	// Keep the element out of view and prevent it from affecting layout or scroll.
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.top = '-9999px';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);

	try {
		textarea.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}

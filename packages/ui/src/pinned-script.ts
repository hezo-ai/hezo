/**
 * A `<script>` for a file on another origin, pinned to the Subresource
 * Integrity hashes it must match.
 *
 * **The two attributes travel together.** A browser checks integrity only on a
 * CORS response, so a pinned script without `crossorigin` never loads; and an
 * anonymous request sends no credentials to the other origin. Every third-party
 * script a Hezo site loads is created here, so neither can be left off.
 */
export function pinnedScript(src: string, integrity: string): HTMLScriptElement {
	const script = document.createElement('script');
	script.src = src;
	script.integrity = integrity;
	script.crossOrigin = 'anonymous';
	return script;
}

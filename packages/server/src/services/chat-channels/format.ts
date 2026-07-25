/**
 * Split a long reply on paragraph boundaries so every chunk fits a platform's
 * message length cap (Slack ~4000, Discord 2000, …). A single paragraph over
 * the cap is hard-split. Pure — unit-tested via the adapters that use it.
 */
export function splitMessageForLimit(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let current = '';
	for (const para of text.split('\n\n')) {
		const candidate = current === '' ? para : `${current}\n\n${para}`;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		if (current !== '') chunks.push(current);
		let rest = para;
		while (rest.length > limit) {
			chunks.push(rest.slice(0, limit));
			rest = rest.slice(limit);
		}
		current = rest;
	}
	if (current !== '') chunks.push(current);
	return chunks;
}

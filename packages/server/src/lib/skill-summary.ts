const MAX_SUMMARY_LENGTH = 200;

/**
 * Derive a one-line summary from a skill's markdown body, used to backfill the
 * `description` field when a skill is created/updated without one. The
 * description is what surfaces in the per-run skills manifest, so every skill
 * needs a usable one even when the author omits it.
 *
 * Picks the first meaningful line (skipping blank lines and a leading H1
 * title), strips common inline markdown, and truncates.
 */
export function deriveSkillSummary(content: string): string {
	const lines = content.split('\n');
	let firstHeading: string | null = null;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			// Remember the title heading but prefer the first prose line below it.
			if (firstHeading === null) firstHeading = stripInlineMarkdown(heading[1]);
			continue;
		}
		const text = stripInlineMarkdown(line);
		if (text) return truncate(text);
	}

	return firstHeading ? truncate(firstHeading) : '';
}

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\*\*([^*]*)\*\*/g, '$1')
		.replace(/\*([^*]*)\*/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^[-*+]\s+/, '')
		.trim();
}

function truncate(text: string): string {
	if (text.length <= MAX_SUMMARY_LENGTH) return text;
	return `${text.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

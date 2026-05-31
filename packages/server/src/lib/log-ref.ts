// Formats an entity for logs as "label (uuid)", or just the uuid when no
// friendly label is available.
export const ref = (label: string | null | undefined, id: string): string =>
	label ? `${label} (${id})` : id;

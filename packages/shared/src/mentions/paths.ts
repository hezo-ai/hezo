/**
 * Relative URL paths for entity references, matching the web app's routes.
 * The web remark plugin emits these as-is (client-side navigation); server-side
 * channel renderers prefix the instance base URL to produce absolute links.
 * Callers pass project slugs (browser URLs use slugs, never UUIDs).
 */

export function taskPath(projectSlug: string, identifier: string): string {
	return `/projects/${projectSlug}/tasks/${identifier.toLowerCase()}`;
}

export function commentPath(projectSlug: string, identifier: string, commentId: string): string {
	return `${taskPath(projectSlug, identifier)}#comment-${commentId}`;
}

export function projectDocPath(projectSlug: string, filename: string): string {
	return `/projects/${projectSlug}/documents?file=${encodeURIComponent(filename)}`;
}

export function assetPath(projectSlug: string, filename: string): string {
	// The in-app asset viewer (content + review comments) is the canonical link
	// target for an asset; raw view is reachable from its toolbar.
	return `/projects/${projectSlug}/assets/view?file=${encodeURIComponent(filename)}`;
}

export function agentPath(projectSlug: string, agentSlug: string): string {
	return `/projects/${projectSlug}/agents/${agentSlug}`;
}

export function projectInboxPath(projectSlug: string): string {
	return `/projects/${projectSlug}/inbox`;
}

/** Instance-wide admin inbox (used when no project context exists). */
export const GLOBAL_INBOX_PATH = '/home/inbox';

/** Skills (KB docs) live in instance settings, not under a project. */
export const SKILLS_SETTINGS_PATH = '/settings/skills';

import { CEO_AGENT_SLUG, COACH_AGENT_SLUG } from '@hezo/shared';

// Built-in default avatars for the HQ singleton agents (CEO, Coach). These two
// roles are the same across every project, so Hezo ships a default portrait for
// them (served from `public/avatars/`, bundled into the web app). Per-project
// roles like the Captain deliberately get NO built-in default — they fall back to
// initials unless a custom avatar is uploaded.
const DEFAULT_AVATARS: Record<string, string> = {
	[CEO_AGENT_SLUG]: '/avatars/ceo.png',
	[COACH_AGENT_SLUG]: '/avatars/coach.png',
};

/**
 * The built-in default avatar URL for an agent slug, or undefined when the role
 * has none. A user-uploaded avatar always takes precedence: callers resolve the
 * effective image as `iconUrl ?? defaultAvatarForSlug(slug)`, so the upload wins
 * and this only fills the gap for CEO/Coach that have no custom icon.
 */
export function defaultAvatarForSlug(slug: string | null | undefined): string | undefined {
	return slug ? DEFAULT_AVATARS[slug] : undefined;
}

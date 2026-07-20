import { CEO_AGENT_SLUG, COACH_AGENT_SLUG } from '@hezo/shared';
import { expect, test } from 'vitest';
import { defaultAvatarForSlug } from '../src/lib/default-avatars';

test('CEO and Coach (HQ singletons) resolve to their built-in default avatars', () => {
	expect(defaultAvatarForSlug(CEO_AGENT_SLUG)).toBe('/avatars/ceo.png');
	expect(defaultAvatarForSlug(COACH_AGENT_SLUG)).toBe('/avatars/coach.png');
});

test('per-project and unknown roles have no built-in default', () => {
	// Captains are per-project, so they intentionally get no shared default avatar.
	expect(defaultAvatarForSlug('captain')).toBeUndefined();
	expect(defaultAvatarForSlug('engineer')).toBeUndefined();
	expect(defaultAvatarForSlug(null)).toBeUndefined();
	expect(defaultAvatarForSlug(undefined)).toBeUndefined();
});

import { type AvatarSpec, isAvatarSpec, pixelAvatarDataUri } from '@hezo/shared';
import { defaultAvatarForSlug } from './default-avatars';

/**
 * The image to show for an agent, or undefined to fall back to initials.
 *
 * One resolution order, used by every agent-avatar surface so a teammate looks
 * the same in the roster, the org chart, a comment and the inbox:
 *
 *   1. The shipped portrait for the HQ singletons (CEO, Coach), which are the
 *      same role on every instance and so get a hand-drawn face.
 *   2. The agent's own generated sprite, drawn from its stored spec.
 *
 * Humans never route through here - they keep their uploaded picture or their
 * initials.
 */
export function agentAvatarUrl(agent: {
	slug?: string | null;
	avatar_spec?: unknown;
}): string | undefined {
	const shipped = defaultAvatarForSlug(agent.slug);
	if (shipped) return shipped;
	return isAvatarSpec(agent.avatar_spec) ? pixelAvatarDataUri(agent.avatar_spec) : undefined;
}

/**
 * Three candidate faces for the "generate a new avatar" picker, plus the seed
 * each was drawn from - the seed is what gets saved, and the server recomposes
 * the same spec from it.
 *
 * Generated client-side because it is a preview: nothing is stored until the
 * admin picks one, so a round trip per shuffle would be latency for nothing. The
 * role's outfit and the agent's gender are held fixed, so the options differ
 * only in the face, and the server derives those two itself on save.
 */
export function generateAvatarOptions(
	agent: { avatar_spec?: unknown },
	count = 3,
): Array<{ seed: string; url: string }> {
	const current = isAvatarSpec(agent.avatar_spec) ? agent.avatar_spec : null;
	const base: Omit<AvatarSpec, 'seed'> = current
		? { gender: current.gender, style: current.style }
		: { gender: 'n', style: 'default' };
	return Array.from({ length: count }, () => {
		const seed = crypto.randomUUID();
		return { seed, url: pixelAvatarDataUri({ ...base, seed }) };
	});
}

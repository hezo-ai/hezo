/**
 * Human names for agents: validation, and the name -> gender inference used to
 * pick an avatar's feature set.
 *
 * Inference is a **fallback only**. Every role shipped in a marketplace team
 * carries an explicit gender in its bundle, because a lookup table would
 * mis-gender exactly the short, modern names teams like to use ("Nova", "Dev",
 * "Kai"). Inference exists for the one case with no authored answer: a bespoke
 * runtime hire whose name a Captain or admin just typed.
 */

import type { AgentGender } from '../types/common.js';

/** Longest accepted human name. Long enough for "Alexandra", short enough to fit a sidebar row. */
export const AGENT_HUMAN_NAME_MAX = 40;

/**
 * Common given names by gender, lowercased. Deliberately a short, high-frequency
 * list rather than an exhaustive corpus: an unlisted name resolves to `n`
 * (neutral), which produces a perfectly good seeded avatar. Growing this list
 * improves guesses; it never fixes a wrong one, since an author who cares sets
 * the gender explicitly.
 */
const FEMALE_NAMES =
	'ada adele agnes aisha alice alexandra amara amelia ana anna anita aria astrid aurora ava ' +
	'beatriz bianca carla carmen cecilia chloe clara cleo daniela diana elena elif elsa emilia ' +
	'emma eva fatima freya gabriela grace hana hannah helena ingrid irene iris isabel isla ivy ' +
	'jasmine julia kate laura leila lena lila lina lucia luna maria marta maya mei mia nadia ' +
	'naomi nina nora nova olivia paula petra priya rania rosa ruby ruth sara sarah sofia sophia ' +
	'stella tara tessa thea vera wren yara yuki zara zoe';

const MALE_NAMES =
	'aaron adam ahmed alan albert alex ali andre andres arjun arlo arthur ben bruno caleb carlos ' +
	'cesar daniel david dev diego dmitri eli elias emil enzo eric ethan felix finn gabriel george ' +
	'gustav hans harold hassan hector henry hugo ian igor isaac ivan jack jamal james jonas jonah ' +
	'jorge jose juan kai karl kenji kevin leo liam lucas luis marco marcus mateo matteo max ' +
	'miguel nathan niko noah oliver omar oscar pablo paulo pedro peter rafael raj ravi reuben ' +
	'rui ryan samir sean sergei simon theo thomas tobias victor viktor wei yusuf';

const FEMALE_SET = new Set(FEMALE_NAMES.split(' '));
const MALE_SET = new Set(MALE_NAMES.split(' '));

/**
 * Best-effort gender for a human name, for choosing avatar features. Returns
 * `n` for anything unrecognised, which the generator resolves from the seed -
 * so an unknown name still gets a stable, sensible face.
 *
 * Only the first word is considered: "Ana Maria" is keyed on "ana".
 */
export function inferGender(name: string | null | undefined): AgentGender {
	const first = (name ?? '').trim().toLowerCase().split(/\s+/)[0];
	if (!first) return 'n';
	if (FEMALE_SET.has(first)) return 'f';
	if (MALE_SET.has(first)) return 'm';
	return 'n';
}

/**
 * Validate a human name, returning an error message or null. Runs on both sides:
 * the settings and hire forms call it for inline feedback, and every server
 * write path enforces it.
 *
 * An empty string is valid and means "no human name" - that is how a name is
 * cleared, falling the agent back to its role.
 */
export function humanNameError(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > AGENT_HUMAN_NAME_MAX) {
		return `Name must be ${AGENT_HUMAN_NAME_MAX} characters or fewer`;
	}
	if (!/\p{L}/u.test(trimmed)) return 'Name must contain at least one letter';
	// The name becomes a mention handle, so anything that would break the `@token`
	// grammar or read as a second mention is rejected up front.
	if (/[@\n\r]/.test(trimmed)) return 'Name cannot contain @ or line breaks';
	// A name whose slug is empty (e.g. "***") could never be mentioned.
	if (!/[a-z0-9]/i.test(trimmed)) return 'Name must contain a letter or digit';
	return null;
}

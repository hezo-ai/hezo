/**
 * Deterministic pixel-art agent avatars.
 *
 * An agent's avatar is not an uploaded image but a tiny **spec** (`AvatarSpec`)
 * stored on the agent and bundled into a marketplace team. Rendering is pure and
 * deterministic: the same spec always produces the same sprite, on every device,
 * with no storage and no network. That is what lets a team ship fixed faces
 * ("Max the Engineer looks the same in every project") in a few dozen bytes.
 *
 * Output is inline SVG rather than canvas so it renders identically under
 * happy-dom, in tests and on the server, and stays crisp at any size
 * (`shape-rendering: crispEdges` keeps the pixel grid hard-edged when scaled).
 */

import type { AgentGender } from '../types/common.js';

/** Logical sprite grid. The bust is composed on a 24x24 field of "pixels". */
const GRID = 24;

/**
 * The stored description of an agent's avatar - everything needed to redraw it.
 * Small enough to live in a JSONB column and in a team bundle.
 */
export interface AvatarSpec {
	/** Any string; hashed to drive every random feature choice. */
	seed: string;
	/** Drives the face/hair/build feature set. `n` picks one from the seed. */
	gender: AgentGender;
	/** Role-derived outfit + accessory family. See `AVATAR_STYLES`. */
	style: string;
}

/* ── Deterministic randomness ─────────────────────────────────────────── */

/** FNV-1a: a fast, well-distributed string hash with no dependencies. */
function fnv1a(str: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** mulberry32: a compact, high-quality 32-bit PRNG seeded from the hash. */
function mulberry32(a: number): () => number {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function choose<T>(rnd: () => number, arr: readonly T[]): T {
	return arr[Math.floor(rnd() * arr.length)];
}

/* ── Palette helpers ──────────────────────────────────────────────────── */

function clampByte(v: number): number {
	return Math.max(0, Math.min(255, Math.round(v)));
}

function shade(hex: string, factor: number): string {
	const r = clampByte(Number.parseInt(hex.slice(1, 3), 16) * (1 + factor));
	const g = clampByte(Number.parseInt(hex.slice(3, 5), 16) * (1 + factor));
	const b = clampByte(Number.parseInt(hex.slice(5, 7), 16) * (1 + factor));
	const to2 = (v: number) => v.toString(16).padStart(2, '0');
	return `#${to2(r)}${to2(g)}${to2(b)}`;
}

const SKIN_TONES = [
	'#f6d7b8',
	'#eec39a',
	'#e0ac69',
	'#c98a52',
	'#a86a3d',
	'#8d5524',
	'#6b4423',
] as const;
const HAIR_COLORS = [
	'#26201e',
	'#3c2a1e',
	'#59371f',
	'#7a4a26',
	'#9c6b31',
	'#c9a227',
	'#b3502e',
	'#8a8d93',
	'#2e3450',
] as const;
/** Occasional dyed hair, kept rare so a roster still reads as a workplace. */
const NOVELTY_HAIR = ['#2e8f83', '#7a4fb0', '#b0487a'] as const;
const LIP_COLOR = '#b3583f';
const INK = '#181c24';
/** Pale lens fill, so spectacles read as glass rather than as sunglasses. */
const LENS = '#dbe7f0';
const OUTLINE = '#12151c';
const GOLD = '#e8b93c';
const LINEN = '#e8e4da';

/* ── Role styles ──────────────────────────────────────────────────────── */

type Collar = 'crew' | 'collar' | 'hoodie' | 'polo' | 'cardigan' | 'jacket';
type Accessory = 'none' | 'glasses' | 'headset' | 'cap' | 'beret' | 'captainhat' | 'visor';

interface AvatarStyle {
	cloth: readonly string[];
	collar: readonly Collar[];
	accessories: readonly Accessory[];
	/** Probability that an accessory is drawn at all. */
	accessoryChance: number;
}

/**
 * Outfit families keyed by role. A role's *kind* of work picks the palette and
 * the accessory, so a roster reads at a glance even at 26px: the Captain's hat,
 * support's headset, the designer's beret.
 */
export const AVATAR_STYLES: Record<string, AvatarStyle> = {
	captain: {
		cloth: ['#274a76', '#1f3a5f', '#2c5382'],
		collar: ['jacket'],
		accessories: ['captainhat'],
		accessoryChance: 1,
	},
	writer: {
		cloth: ['#c9972f', '#b07d2a', '#a2622e', '#8f6a3a'],
		collar: ['cardigan', 'crew'],
		accessories: ['glasses', 'none'],
		accessoryChance: 0.7,
	},
	engineering: {
		cloth: ['#3b4a8f', '#2f3e75', '#41569e', '#35406b'],
		collar: ['hoodie', 'crew'],
		accessories: ['glasses', 'none'],
		accessoryChance: 0.5,
	},
	ops: {
		cloth: ['#49525c', '#3d4650', '#55606c'],
		collar: ['crew', 'hoodie'],
		accessories: ['cap', 'none'],
		accessoryChance: 0.55,
	},
	security: {
		cloth: ['#2f3a4a', '#26303e', '#374556'],
		collar: ['collar', 'crew'],
		accessories: ['glasses', 'visor'],
		accessoryChance: 0.8,
	},
	design: {
		cloth: ['#8e4fa8', '#a8548e', '#7a4fb0', '#b0487a'],
		collar: ['crew', 'cardigan'],
		accessories: ['beret', 'glasses', 'none'],
		accessoryChance: 0.7,
	},
	research: {
		cloth: ['#2e7f7a', '#2a6f80', '#33707f'],
		collar: ['collar', 'crew'],
		accessories: ['glasses'],
		accessoryChance: 0.9,
	},
	marketing: {
		cloth: ['#c05a35', '#b34a2e', '#c2643f'],
		collar: ['collar', 'crew'],
		accessories: ['none', 'glasses'],
		accessoryChance: 0.4,
	},
	support: {
		cloth: ['#3f8a4f', '#357a49', '#4a9159'],
		collar: ['polo', 'crew'],
		accessories: ['headset'],
		accessoryChance: 1,
	},
	lead: {
		cloth: ['#3a6ea5', '#2e5f95', '#43679b'],
		collar: ['collar'],
		accessories: ['none', 'glasses'],
		accessoryChance: 0.5,
	},
	default: {
		cloth: ['#6b5b95', '#4a7c82', '#8a6a4f', '#5f7a52', '#7a5560'],
		collar: ['crew', 'collar', 'hoodie'],
		accessories: ['none', 'glasses'],
		accessoryChance: 0.4,
	},
};

/**
 * Role text -> style key. First match wins, so order matters: the more specific
 * families (security, devops) are tested before the broad `engineer` catch.
 */
const ROLE_STYLE_MATCHERS: ReadonlyArray<readonly [RegExp, string]> = [
	[/captain/, 'captain'],
	[/security|threat|vulnerab|compliance/, 'security'],
	[/devops|sre|infra|platform|deploy|release|\bops\b/, 'ops'],
	[/writ|content|copy|edit|blog|journal|comms|report/, 'writer'],
	[/design|\bux\b|\bui\b|brand|creative|art|illustr/, 'design'],
	[
		/engineer|develop|code|program|backend|frontend|fullstack|software|\bqa\b|test|architect/,
		'engineering',
	],
	[/research|analy|data|scien|\bml\b|insight|equity|market-research|catalyst|risk/, 'research'],
	[/market|growth|\bseo\b|social|sales|account|outreach|advertis|distribution/, 'marketing'],
	[/support|success|community|help/, 'support'],
	[/product|manager|lead|coordinator|chief|strateg/, 'lead'],
];

/**
 * Pick the outfit family for a role from its slug and title. Exported because
 * the server derives a spec for agents with no bundled identity (the Captain,
 * runtime hires) and must land on the same family the web would.
 */
export function styleForRole(roleSlug: string, roleTitle: string): string {
	const haystack = `${roleSlug} ${roleTitle}`.toLowerCase();
	for (const [re, style] of ROLE_STYLE_MATCHERS) {
		if (re.test(haystack)) return style;
	}
	return 'default';
}

/** Build a spec for an agent, deriving the outfit family from its role. */
export function makeAvatarSpec(input: {
	seed: string;
	gender: AgentGender;
	roleSlug: string;
	roleTitle: string;
}): AvatarSpec {
	return {
		seed: input.seed,
		gender: input.gender,
		style: styleForRole(input.roleSlug, input.roleTitle),
	};
}

/* ── Sprite composition ───────────────────────────────────────────────── */

type Cell = string | null;

function buildGrid(spec: AvatarSpec): Cell[] {
	const style = AVATAR_STYLES[spec.style] ?? AVATAR_STYLES.default;
	const rnd = mulberry32(fnv1a(`${spec.seed}|${spec.style}|${spec.gender}`));
	// A neutral spec still yields a concrete face - chosen from the seed, so it
	// is stable rather than arbitrary.
	const feminine = spec.gender === 'f' || (spec.gender === 'n' && rnd() < 0.5);

	const g: Cell[] = new Array(GRID * GRID).fill(null);
	const set = (x: number, y: number, c: string) => {
		if (x >= 0 && x < GRID && y >= 0 && y < GRID) g[y * GRID + x] = c;
	};
	const rect = (x: number, y: number, w: number, h: number, c: string) => {
		for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c);
	};

	const skin = choose(rnd, SKIN_TONES);
	const skinShade = shade(skin, -0.18);
	const hair = rnd() < 0.07 ? choose(rnd, NOVELTY_HAIR) : choose(rnd, HAIR_COLORS);
	const hairHi = shade(hair, 0.22);
	const cloth = choose(rnd, style.cloth);
	const clothShade = shade(cloth, -0.2);
	const clothHi = shade(cloth, 0.14);
	const accessory: Accessory =
		rnd() < style.accessoryChance ? choose(rnd, style.accessories) : 'none';
	const hatted = accessory === 'captainhat' || accessory === 'beret' || accessory === 'cap';
	const hairStyle = feminine
		? choose(rnd, ['long', 'bob', 'ponytail', 'bun', 'wavy', 'sidepart'] as const)
		: choose(rnd, ['short', 'spiky', 'side', 'buzz', 'crop'] as const);

	// Torso + shoulders.
	rect(5, 18, 14, 6, cloth);
	rect(4, 19, 16, 5, cloth);
	rect(6, 17, 12, 1, cloth);
	for (let y = 18; y < 24; y++) {
		set(16, y, clothShade);
		set(17, y, clothShade);
		set(18, y, clothShade);
	}
	for (let y = 20; y < 24; y++) set(19, y, clothShade);
	// Neck.
	rect(10, 15, 4, 2, skin);
	set(13, 15, skinShade);
	set(13, 16, skinShade);

	// Long hair falls behind the shoulders, so it is laid down before the collar.
	if (
		feminine &&
		!hatted &&
		(hairStyle === 'long' || hairStyle === 'wavy' || hairStyle === 'sidepart')
	) {
		rect(5, 7, 2, 12, hair);
		rect(17, 7, 2, 12, hair);
		if (hairStyle === 'wavy') {
			set(5, 19, hair);
			set(6, 18, hair);
			set(18, 18, hair);
		}
	}

	// Collar / garment detail.
	switch (choose(rnd, style.collar)) {
		case 'hoodie':
			rect(8, 17, 8, 1, clothHi);
			set(8, 18, clothHi);
			set(15, 18, clothHi);
			set(10, 19, LINEN);
			set(13, 19, LINEN);
			break;
		case 'collar':
			set(9, 17, LINEN);
			set(10, 17, LINEN);
			set(13, 17, LINEN);
			set(14, 17, LINEN);
			set(11, 18, clothShade);
			set(12, 18, clothShade);
			break;
		case 'polo':
			set(10, 17, clothShade);
			set(13, 17, clothShade);
			set(11, 18, clothHi);
			set(12, 18, clothHi);
			break;
		case 'cardigan':
			for (let y = 18; y < 24; y++) {
				set(11, y, clothShade);
				set(12, y, clothShade);
			}
			set(11, 19, '#d8cfb8');
			set(12, 21, '#d8cfb8');
			break;
		case 'jacket':
			for (let y = 17; y < 24; y++) {
				set(11, y, LINEN);
				set(12, y, LINEN);
			}
			set(10, 18, clothShade);
			set(13, 18, clothShade);
			set(10, 20, GOLD);
			set(13, 20, GOLD);
			set(10, 22, GOLD);
			set(13, 22, GOLD);
			break;
		default:
			break;
	}
	if (spec.style === 'captain') {
		rect(4, 18, 3, 1, GOLD);
		rect(17, 18, 3, 1, GOLD);
		set(4, 19, shade(GOLD, -0.2));
		set(19, 19, shade(GOLD, -0.2));
	}

	// Head.
	rect(7, 6, 10, 9, skin);
	rect(8, 15, 8, 1, skin);
	set(7, 14, skinShade);
	set(16, 6, skinShade);
	for (let y = 7; y < 15; y++) {
		set(15, y, skinShade);
		set(16, y, skinShade);
	}
	set(6, 10, skin);
	set(6, 11, skinShade);
	set(17, 10, skinShade);
	set(17, 11, skinShade);

	// Hair on top of the head (a hat replaces it, leaving only side wisps).
	if (hatted) {
		set(7, 8, hair);
		set(16, 8, hair);
	} else if (!feminine) {
		switch (hairStyle) {
			case 'buzz':
				rect(7, 5, 10, 2, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				break;
			case 'spiky':
				rect(7, 4, 10, 3, hair);
				set(8, 3, hair);
				set(11, 3, hair);
				set(14, 3, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				set(9, 4, hairHi);
				set(12, 4, hairHi);
				break;
			case 'side':
				rect(7, 4, 10, 3, hair);
				rect(7, 7, 6, 1, hair);
				set(16, 7, hair);
				rect(9, 4, 4, 1, hairHi);
				break;
			case 'crop':
				rect(7, 4, 10, 3, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				rect(9, 4, 5, 1, hairHi);
				break;
			default:
				rect(7, 4, 10, 3, hair);
				set(7, 7, hair);
				set(8, 7, hair);
				set(15, 7, hair);
				set(16, 7, hair);
				set(7, 8, hair);
				set(16, 8, hair);
				rect(8, 4, 3, 1, hairHi);
				break;
		}
	} else {
		switch (hairStyle) {
			case 'bob':
				rect(7, 4, 10, 3, hair);
				rect(6, 5, 1, 9, hair);
				rect(17, 5, 1, 9, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				set(6, 13, hair);
				set(17, 13, hair);
				rect(9, 4, 3, 1, hairHi);
				break;
			case 'ponytail':
				rect(7, 4, 10, 3, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				rect(17, 6, 2, 6, hair);
				set(18, 5, hair);
				rect(9, 4, 3, 1, hairHi);
				break;
			case 'bun':
				rect(7, 4, 10, 3, hair);
				rect(10, 1, 4, 2, hair);
				set(9, 2, hair);
				set(14, 2, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				set(11, 1, hairHi);
				break;
			case 'sidepart':
				rect(7, 3, 10, 4, hair);
				set(6, 6, hair);
				set(17, 4, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				rect(9, 4, 4, 1, hairHi);
				break;
			default:
				rect(7, 3, 10, 4, hair);
				set(6, 5, hair);
				set(17, 5, hair);
				set(6, 6, hair);
				set(17, 6, hair);
				set(7, 7, hair);
				set(16, 7, hair);
				rect(9, 4, 3, 1, hairHi);
				break;
		}
		if (rnd() < 0.4) {
			set(6, 12, GOLD);
			set(17, 12, GOLD);
		}
	}

	// Face.
	rect(9, 10, 2, 1, INK);
	rect(13, 10, 2, 1, INK);
	if (!feminine && accessory !== 'glasses' && rnd() < 0.5) {
		set(9, 9, hair);
		set(10, 9, hair);
		set(13, 9, hair);
		set(14, 9, hair);
	}
	if (feminine) {
		set(8, 10, INK);
		set(15, 10, INK);
		set(11, 13, LIP_COLOR);
		set(12, 13, LIP_COLOR);
		set(11, 14, shade(LIP_COLOR, -0.2));
	} else {
		const mouth = shade(skin, -0.45);
		set(11, 13, mouth);
		set(12, 13, mouth);
		if (rnd() < 0.18) {
			rect(10, 14, 4, 1, hair);
			set(9, 13, hair);
			set(14, 13, hair);
		}
	}

	// Accessories.
	switch (accessory) {
		case 'glasses':
			// Lenses are drawn wide enough to hold a pale lens pixel beside the
			// pupil - a frame flush against the eye reads as sunglasses at 26px.
			rect(7, 9, 4, 1, INK);
			rect(13, 9, 4, 1, INK);
			rect(7, 11, 4, 1, INK);
			rect(13, 11, 4, 1, INK);
			set(7, 10, INK);
			set(10, 10, INK);
			set(13, 10, INK);
			set(16, 10, INK);
			set(8, 10, LENS);
			set(15, 10, LENS);
			set(9, 10, INK);
			set(14, 10, INK);
			set(11, 10, INK);
			set(12, 10, INK);
			break;
		case 'visor':
			rect(7, 9, 10, 1, INK);
			rect(8, 10, 8, 1, '#4a90d9');
			set(7, 10, INK);
			set(16, 10, INK);
			break;
		case 'headset':
			rect(7, 3, 10, 1, INK);
			set(6, 4, INK);
			set(17, 4, INK);
			rect(5, 9, 2, 3, INK);
			rect(17, 9, 2, 3, INK);
			set(5, 10, '#3fae5a');
			set(5, 12, INK);
			set(6, 13, INK);
			set(7, 13, INK);
			set(8, 13, '#3fae5a');
			break;
		case 'cap':
			rect(7, 3, 10, 3, cloth);
			rect(6, 6, 12, 1, clothShade);
			rect(5, 6, 2, 1, clothShade);
			set(8, 4, clothHi);
			set(9, 4, clothHi);
			break;
		case 'beret':
			rect(7, 4, 9, 2, '#8a3b4a');
			rect(6, 5, 3, 1, '#8a3b4a');
			set(11, 3, '#6e2f3b');
			set(12, 3, '#6e2f3b');
			break;
		case 'captainhat':
			rect(7, 3, 10, 2, '#ece7da');
			rect(6, 5, 12, 1, '#ece7da');
			rect(6, 6, 12, 1, '#20304a');
			set(11, 6, GOLD);
			set(12, 6, GOLD);
			rect(8, 7, 8, 1, '#141e30');
			set(9, 4, '#f8f4e8');
			set(10, 4, '#f8f4e8');
			break;
		default:
			break;
	}

	// A single dark outline around the whole silhouette. Drawn last, into the
	// empty cells touching a filled one, so the bust reads at 26px.
	const outlined: number[] = [];
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			if (g[y * GRID + x]) continue;
			const touches =
				(x > 0 && g[y * GRID + x - 1]) ||
				(x < GRID - 1 && g[y * GRID + x + 1]) ||
				(y > 0 && g[(y - 1) * GRID + x]) ||
				(y < GRID - 1 && g[(y + 1) * GRID + x]);
			if (touches) outlined.push(y * GRID + x);
		}
	}
	for (const i of outlined) g[i] = OUTLINE;
	return g;
}

/* ── Rendering ────────────────────────────────────────────────────────── */

/**
 * Render a spec to a standalone SVG string. Horizontal runs of one colour merge
 * into a single `<rect>`, which roughly halves the markup versus a rect per
 * pixel - it matters because this string is inlined as a data URI on every
 * avatar in a roster.
 */
export function pixelAvatarSvg(spec: AvatarSpec): string {
	const g = buildGrid(spec);
	const parts: string[] = [];
	for (let y = 0; y < GRID; y++) {
		let x = 0;
		while (x < GRID) {
			const color = g[y * GRID + x];
			if (!color) {
				x++;
				continue;
			}
			let run = 1;
			while (x + run < GRID && g[y * GRID + x + run] === color) run++;
			parts.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${color}"/>`);
			x += run;
		}
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" ` +
		`shape-rendering="crispEdges">${parts.join('')}</svg>`
	);
}

/**
 * Memoized `data:` URI for an `<img src>`.
 *
 * Bounded LRU-ish cache: a roster re-renders the same handful of specs on every
 * navigation, so caching pays, but the key space is unbounded (every regenerated
 * option is a new seed). At the cap the oldest entries are dropped wholesale -
 * specs are immutable, so a stale entry is impossible and eviction only costs a
 * recompute.
 */
const AVATAR_CACHE_MAX = 256;
const avatarCache = new Map<string, string>();

export function pixelAvatarDataUri(spec: AvatarSpec): string {
	const key = `${spec.seed}|${spec.gender}|${spec.style}`;
	const hit = avatarCache.get(key);
	if (hit !== undefined) return hit;
	const uri = `data:image/svg+xml,${encodeURIComponent(pixelAvatarSvg(spec))}`;
	if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.clear();
	avatarCache.set(key, uri);
	return uri;
}

/** Type guard for a spec arriving from the DB or an untrusted bundle. */
export function isAvatarSpec(value: unknown): value is AvatarSpec {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.seed === 'string' &&
		typeof v.style === 'string' &&
		(v.gender === 'f' || v.gender === 'm' || v.gender === 'n')
	);
}

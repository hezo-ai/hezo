/**
 * Source of truth for every generated Hezo icon bitmap.
 *
 * Pure: no I/O, no dependencies. `scripts/generate-icons.ts` rasterizes the SVGs
 * this emits; `test/pwa-icons.test.ts` asserts the safe-zone maths without
 * rasterizing anything.
 *
 * The mark is the CJK character 合, rebuilt here from primitives. The committed
 * `public/logo.svg` carries the same glyph as a 74KB flattened Figma export
 * (1764 vertices for what is really three shapes plus a seven-point polygon);
 * the two "interior notches" in that path are collinear artifacts of the flatten
 * and drop out of the reconstruction.
 */

export const CANVAS = 514;
export const BRAND_RED = '#DB3B2C';

/** 人 - apex-up chevron. Seven real corners; everything else in the export was flattening noise. */
export const CHEVRON =
	'M244.1 115 h23.5 l131.8 107.1 l-16 21.5 l-126.2 -104.4 l-123.4 105.9 l-15.2 -19.1 Z';
/** 一 - the horizontal bar. */
export const BAR = 'M207.6 229.2 h99.3 v21.8 h-99.3 Z';
/** 口 - the box, as an even-odd pair so the stroke stays the typeface's own uneven weight. */
export const BOX = 'M181.7 295.9 h153.9 V399 H181.7 Z M202.1 315 h112.6 v65.1 H202.1 Z';

export const GLYPH_BBOX = { x0: 118.6, y0: 115, x1: 399.4, y1: 399 } as const;
export const GLYPH_WIDTH = GLYPH_BBOX.x1 - GLYPH_BBOX.x0;
/** The glyph's own centre, which is 2 units right of the canvas centre. */
export const GLYPH_CENTER = { x: 259.0, y: 257.0 } as const;

/**
 * Android guarantees only the central 80% circle survives every launcher mask.
 * Anything outside it may be cropped, so this is the budget the framed variants
 * are solved against.
 */
export const SAFE_RADIUS = 0.4 * CANVAS;

/** The brand frame's own proportions, read off `public/logo.svg` (rect 401, rx 23, stroke 18). */
export const BRAND_RX_RATIO = 23 / 200.5;
export const BRAND_STROKE_RATIO = 18 / 401;
/** The brand lockup's glyph-to-frame-interior ratio, preserved by the maskable variants. */
export const BRAND_GLYPH_FILL = 0.733;

/**
 * Corner radius as a fraction of the frame's half-side, for the masked variants.
 *
 * A rounded square's furthest point from centre is its outer corner arc. Tight
 * corners throw that point far out along the diagonal, so a tight-cornered frame
 * has to shrink drastically to fit the safe circle. Rounding the corners pulls
 * the extremes in and buys size instead: at the brand's own 0.115 the frame
 * solves to 291 units, at 0.55 it solves to 334 for the identical budget.
 *
 * 0.55 also reads as an echo of the launcher's own squircle rather than a second
 * competing silhouette inside it.
 */
export const MASKED_RX_RATIO = 0.55;

const C = CANVAS / 2;

export type IconVariant = 'any' | 'maskable' | 'monochrome' | 'apple';

export interface FrameSpec {
	/** Corner radius as a fraction of the half-side. 0 is square, 1 is a circle. */
	rxRatio: number;
	/** Stroke width as a fraction of the side. */
	strokeRatio: number;
	/** Glyph width as a fraction of the frame's inner width. */
	glyphFill: number;
	/** How far from centre the frame's outermost painted pixel may sit. */
	budget?: number;
	/** Pin the centreline side directly instead of solving for it. */
	side?: number;
}

export interface FrameMetrics {
	side: number;
	stroke: number;
	rx: number;
	inner: number;
	/** Distance from centre to the outermost painted pixel of the frame. */
	reach: number;
}

/**
 * Largest centreline side whose outer corner arc lands exactly on `budget`.
 *
 * For an outer half-side H and outer corner radius R the furthest painted point
 * is (H - R) * sqrt(2) + R. Substituting H and R in terms of the centreline side
 * S and solving for S gives the expression below.
 */
export function solveFrameSide(budget: number, rxRatio: number, strokeRatio: number): number {
	const denom = (1 - rxRatio) * Math.SQRT2 + rxRatio + strokeRatio;
	return (2 * budget) / denom;
}

export function frameMetrics(spec: FrameSpec): FrameMetrics {
	const { rxRatio, strokeRatio, budget = SAFE_RADIUS, side } = spec;
	const s = side ?? solveFrameSide(budget, rxRatio, strokeRatio);
	const stroke = strokeRatio * s;
	const rx = (rxRatio * s) / 2;
	const outerHalf = s / 2 + stroke / 2;
	const outerRx = rx + stroke / 2;
	return {
		side: s,
		stroke,
		rx,
		inner: s - stroke,
		reach: (outerHalf - outerRx) * Math.SQRT2 + outerRx,
	};
}

/** The frame + glyph lockup used by every masked variant. */
export const MASKED_FRAME: FrameSpec = {
	rxRatio: MASKED_RX_RATIO,
	strokeRatio: BRAND_STROKE_RATIO,
	glyphFill: BRAND_GLYPH_FILL,
	budget: SAFE_RADIUS,
};

/** The lockup as drawn in logo.svg: frame at full size, glyph at its native scale. */
export const FULL_FRAME: FrameSpec = {
	rxRatio: BRAND_RX_RATIO,
	strokeRatio: BRAND_STROKE_RATIO,
	glyphFill: GLYPH_WIDTH / (401 - 18),
	side: 401,
};

const n = (v: number) => Number(v.toFixed(3)).toString();

function glyphGroup(scale: number): string {
	const t =
		scale === 1
			? ''
			: ` transform="translate(${n(C)} ${n(C)}) scale(${n(scale)}) ` +
				`translate(${n(-GLYPH_CENTER.x)} ${n(-GLYPH_CENTER.y)})"`;
	return (
		`<g${t} fill="#fff">` +
		`<path d="${CHEVRON}"/>` +
		`<path d="${BAR}"/>` +
		`<path fill-rule="evenodd" d="${BOX}"/>` +
		`</g>`
	);
}

function frameRect(m: FrameMetrics): string {
	const half = m.side / 2;
	return (
		`<rect x="${n(C - half)}" y="${n(C - half)}" width="${n(m.side)}" height="${n(m.side)}" ` +
		`rx="${n(m.rx)}" fill="none" stroke="#fff" stroke-width="${n(m.stroke)}"/>`
	);
}

function lockup(spec: FrameSpec): string {
	const m = frameMetrics(spec);
	return frameRect(m) + glyphGroup((spec.glyphFill * m.inner) / GLYPH_WIDTH);
}

/**
 * Build one icon variant as a standalone SVG string.
 *
 *  any        - rounded plate, lockup inside the 80% safe circle. The unmasked face: browser
 *               tabs, favicon, install dialogs. It carries the safe-circle lockup rather than
 *               the full-size one because `any` is not reliably left unmasked: an Android
 *               launcher handed this icon (Brave's home-screen shortcuts pick it over the
 *               maskable variant) wraps it in an adaptive icon and crops, and at full size the
 *               frame reached 110% of the safe radius - so the crop ate the frame outright and
 *               clipped the glyph. Sized to the same budget as `maskable`, it survives that.
 *  maskable   - full bleed, no plate rounding, lockup inside the 80% safe circle. The launcher
 *               supplies the only rounded edge, so nothing nests inside its silhouette.
 *  monochrome - the maskable lockup as alpha only, for Android 13+ themed icons. No background:
 *               the system tints the alpha channel and a filled plate would tint solid.
 *  apple      - full bleed, deliberately NOT self-rounded (iOS applies its own superellipse) and
 *               fully opaque (iOS composites transparency against black).
 */
export function iconSvg(variant: IconVariant): string {
	const open =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" ` +
		`width="${CANVAS}" height="${CANVAS}">`;
	const plate = (rx?: number) =>
		`<rect width="${CANVAS}" height="${CANVAS}"` +
		(rx ? ` rx="${n(rx)}"` : '') +
		` fill="${BRAND_RED}"/>`;

	switch (variant) {
		case 'any':
			return `${open}${plate(48)}${lockup(MASKED_FRAME)}</svg>`;
		case 'maskable':
			return `${open}${plate()}${lockup(MASKED_FRAME)}</svg>`;
		case 'apple':
			return `${open}${plate()}${lockup(FULL_FRAME)}</svg>`;
		case 'monochrome':
			return `${open}${lockup(MASKED_FRAME)}</svg>`;
	}
}

export interface IconTarget {
	file: string;
	variant: IconVariant;
	size: number;
	/** Variants with a background fill must paint every pixel to the canvas edge. */
	fullBleed: boolean;
}

/** Every bitmap the generator writes, and what each one must satisfy. */
export const ICON_TARGETS: readonly IconTarget[] = [
	{ file: 'icon-192.png', variant: 'any', size: 192, fullBleed: false },
	{ file: 'icon-512.png', variant: 'any', size: 512, fullBleed: false },
	{ file: 'icon-192-maskable.png', variant: 'maskable', size: 192, fullBleed: true },
	{ file: 'icon-512-maskable.png', variant: 'maskable', size: 512, fullBleed: true },
	{ file: 'icon-monochrome-512.png', variant: 'monochrome', size: 512, fullBleed: false },
	{ file: 'apple-touch-icon.png', variant: 'apple', size: 180, fullBleed: true },
];

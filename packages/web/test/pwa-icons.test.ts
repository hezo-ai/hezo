/**
 * Guards the committed PWA icon bitmaps.
 *
 * Both faults this covers actually shipped. Every icon under public/icons/ was
 * missing its bottom 87 pixels - a constant across three canvas sizes, because
 * the out-of-band generator screenshotted headless Chromium at a window size
 * whose viewport paints shorter than the image it writes. And the maskable
 * variant ran artwork to the edge with a frame reaching 138% of Android's safe
 * circle, so the launcher clipped it. Nothing checked either one.
 *
 * These are byte-level assertions on the committed files, not on a fresh render,
 * so they hold whether the icons came from `bun run build:icons` or anywhere else.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	BRAND_GLYPH_FILL,
	BRAND_RED,
	BRAND_RX_RATIO,
	BRAND_STROKE_RATIO,
	CANVAS,
	frameMetrics,
	ICON_TARGETS,
	MASKED_FRAME,
	SAFE_RADIUS,
	solveFrameSide,
} from '../brand/icon-geometry';
import {
	corners,
	decodePng,
	markReach,
	minAlpha,
	opaqueBounds,
	opaqueCoverage,
} from '../scripts/png';

const PUBLIC = resolve(__dirname, '../public');
const ICONS = resolve(PUBLIC, 'icons');

const load = (file: string) => decodePng(readFileSync(resolve(ICONS, file)));

/**
 * Android guarantees only the central 80% circle survives every launcher mask.
 * 2px of slack absorbs anti-aliased edges without letting a real overshoot pass.
 */
const safeReachLimit = (size: number) => (0.4 * size + 2) / size;

describe('safe-zone geometry', () => {
	test('the masked frame is solved to sit exactly on the safe circle', () => {
		const m = frameMetrics(MASKED_FRAME);
		expect(m.reach).toBeCloseTo(SAFE_RADIUS, 6);
	});

	test('the brand frame as originally drawn overshoots the safe circle', () => {
		// rect 401, rx 23, stroke 18 in logo.svg - reaches 283 against a budget of 205.6.
		// This is the fault, pinned so nobody "restores" it.
		const m = frameMetrics({
			rxRatio: BRAND_RX_RATIO,
			strokeRatio: BRAND_STROKE_RATIO,
			glyphFill: BRAND_GLYPH_FILL,
			side: 401,
		});
		expect(m.reach).toBeGreaterThan(SAFE_RADIUS * 1.3);
	});

	test('softening the corners buys frame size for the same budget', () => {
		const tight = solveFrameSide(SAFE_RADIUS, BRAND_RX_RATIO, BRAND_STROKE_RATIO);
		const soft = solveFrameSide(SAFE_RADIUS, MASKED_FRAME.rxRatio, BRAND_STROKE_RATIO);
		expect(soft).toBeGreaterThan(tight * 1.1);
	});

	test('the safe radius is 80% of the canvas, by diameter', () => {
		expect(SAFE_RADIUS).toBeCloseTo(0.4 * CANVAS, 6);
	});
});

describe('committed icon bitmaps', () => {
	test.each(
		ICON_TARGETS.map((t) => [t.file, t] as const),
	)('%s decodes at its declared size', (file, target) => {
		expect(existsSync(resolve(ICONS, file))).toBe(true);
		const img = load(file);
		expect([img.width, img.height]).toEqual([target.size, target.size]);
	});

	// The direct catch for the 87px truncation. A rounded plate still touches all
	// four edges at its midpoints, so filling the bounding box is exact, not a heuristic.
	test.each(
		ICON_TARGETS.filter((t) => t.variant !== 'monochrome').map((t) => [t.file, t] as const),
	)('%s paints to every edge', (file, target) => {
		const b = opaqueBounds(load(file));
		expect(b).toEqual({ x0: 0, y0: 0, x1: target.size - 1, y1: target.size - 1 });
	});

	test.each(
		ICON_TARGETS.filter((t) => t.fullBleed).map((t) => [t.file] as const),
	)('%s is fully opaque', (file) => {
		expect(minAlpha(load(file))).toBe(255);
	});

	test.each(
		ICON_TARGETS.filter((t) => t.variant === 'maskable').map((t) => [t.file, t] as const),
	)('%s keeps its mark inside the safe circle', (file, target) => {
		expect(markReach(load(file))).toBeLessThanOrEqual(safeReachLimit(target.size));
	});

	test('the any-purpose icons keep their rounded plate', () => {
		for (const t of ICON_TARGETS.filter((x) => x.variant === 'any')) {
			const c = corners(load(t.file));
			for (const [name, px] of Object.entries(c)) {
				expect(`${t.file} ${name} alpha=${px[3]}`).toBe(`${t.file} ${name} alpha=0`);
			}
		}
	});

	test('the monochrome icon is alpha only, inside the safe circle, and not blank', () => {
		const img = load('icon-monochrome-512.png');
		for (const px of Object.values(corners(img))) expect(px[3]).toBe(0);
		expect(markReach(img)).toBeLessThanOrEqual(safeReachLimit(img.width));
		// A silently-empty render would still have correct dimensions and transparent corners.
		expect(opaqueCoverage(img)).toBeGreaterThan(0.03);
	});

	test('the apple-touch icon is not self-rounded', () => {
		// iOS applies its own superellipse and composites transparency against black,
		// so a pre-rounded icon nests corners exactly the way One UI's squircle does.
		for (const px of Object.values(corners(load('apple-touch-icon.png')))) {
			expect(px[3]).toBe(255);
		}
	});
});

describe('manifest agrees with what is on disk', () => {
	const manifest = JSON.parse(readFileSync(resolve(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
		icons: { src: string; sizes: string; type: string; purpose: string }[];
		theme_color: string;
		background_color: string;
	};

	test('every declared icon exists at its declared size', () => {
		expect(manifest.icons.length).toBeGreaterThan(0);
		for (const entry of manifest.icons) {
			const file = entry.src.replace(/^\/icons\//, '');
			expect(existsSync(resolve(ICONS, file))).toBe(true);
			const img = load(file);
			expect(`${entry.src} ${img.width}x${img.height}`).toBe(`${entry.src} ${entry.sizes}`);
		}
	});

	test('each purpose is declared singly, and all three are covered', () => {
		const purposes = manifest.icons.map((i) => i.purpose);
		// A combined "any maskable" claims one bitmap is correct for both jobs, which
		// is the mistake that produced the clipped-and-padded icon in the first place.
		for (const p of purposes) expect(p.split(' ')).toHaveLength(1);
		expect(new Set(purposes)).toEqual(new Set(['any', 'maskable', 'monochrome']));
	});

	test('every generated target is either declared or deliberately linked from index.html', () => {
		const declared = new Set(manifest.icons.map((i) => i.src.replace(/^\/icons\//, '')));
		const html = readFileSync(resolve(PUBLIC, '../index.html'), 'utf8');
		for (const t of ICON_TARGETS) {
			expect(`${t.file}: ${declared.has(t.file) || html.includes(t.file)}`).toBe(`${t.file}: true`);
		}
	});

	/**
	 * The launch screen is one flat brand-red field: Android fills it with
	 * `background_color`, and the icon's own plate is painted in BRAND_RED, so the
	 * plate dissolves into the backdrop and only the white frame and glyph remain.
	 * That effect is exact-match or nothing - a background a shade off turns the
	 * plate back into a visible square, which is the mismatched look this replaced
	 * (red band over a white void with a red tile stranded in it).
	 *
	 * The literal is hand-written in three places nothing else keeps in step, so
	 * pin all three to the geometry module's BRAND_RED, which is what the bitmaps
	 * are actually rendered from.
	 */
	test('the splash colours match the red the icon plate is painted in', () => {
		const html = readFileSync(resolve(PUBLIC, '../index.html'), 'utf8');
		const meta = html.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/i)?.[1];
		const brand = BRAND_RED.toLowerCase();
		expect({
			background: manifest.background_color.toLowerCase(),
			theme: manifest.theme_color.toLowerCase(),
			meta: meta?.toLowerCase(),
		}).toEqual({ background: brand, theme: brand, meta: brand });
	});
});

describe('logo.svg has not drifted from the geometry module', () => {
	// logo.svg stays the hand-held source for the unmasked mark (it is the favicon
	// and the in-app logo). It is not generated yet, so pin the frame numbers the
	// module derives its brand ratios from - if someone redraws one, this fails.
	const svg = readFileSync(resolve(PUBLIC, 'logo.svg'), 'utf8');

	test('the plate and frame still match the module constants', () => {
		const plate = svg.match(/<rect width="(\d+)" height="(\d+)"/);
		expect(plate?.[1]).toBe(String(CANVAS));

		const frame = svg.match(
			/width="(\d+)" height="\d+" rx="(\d+)" stroke="white" stroke-width="(\d+)"/,
		);
		expect(frame).not.toBeNull();
		const [side, rx, stroke] = [Number(frame?.[1]), Number(frame?.[2]), Number(frame?.[3])];
		expect(rx / (side / 2)).toBeCloseTo(BRAND_RX_RATIO, 6);
		expect(stroke / side).toBeCloseTo(BRAND_STROKE_RATIO, 6);
	});
});

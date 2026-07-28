/**
 * Regenerate the PWA icon bitmaps from packages/web/brand/icon-geometry.ts.
 *
 *   bun run --cwd packages/web build:icons
 *
 * Author-run, output committed. Deliberately not part of `bun run build` or
 * `bun run dev` - both run in every CI job and on every contributor machine, and
 * neither should require a browser binary. Same posture as `build:marketplace`.
 *
 * Why this script exists at all: the icons it replaces were produced out of band
 * by screenshotting headless Chromium at `--window-size=N,N`, which paints a
 * viewport shorter than the image it writes. Every committed PNG was missing its
 * bottom 87 pixels, at every canvas size, and nothing checked. So this script
 * verifies what it wrote before it writes it - see assertPainted below.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Command } from 'commander';
import { ICON_TARGETS, type IconTarget, iconSvg } from '../brand/icon-geometry';
import { decodePng, minAlpha, opaqueBounds } from './png';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '../public/icons');

/**
 * Playwright pins a Chromium revision that may not be the one actually installed
 * (managed images often ship a different build under PLAYWRIGHT_BROWSERS_PATH).
 * Prefer the pinned path, fall back to any installed build, then give up loudly.
 */
function resolveChromium(explicit?: string): string {
	const candidates: string[] = [];
	if (explicit) candidates.push(explicit);
	if (process.env.HEZO_CHROMIUM_PATH) candidates.push(process.env.HEZO_CHROMIUM_PATH);
	try {
		candidates.push(chromium.executablePath());
	} catch {
		// Playwright throws when no browser is registered at all; the scan below still applies.
	}

	const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (root && existsSync(root)) {
		for (const dir of readdirSync(root)
			.filter((d) => d.startsWith('chromium-'))
			.sort()
			.reverse()) {
			for (const sub of [
				'chrome-linux64/chrome',
				'chrome-linux/chrome',
				'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
				'chrome-win/chrome.exe',
			]) {
				candidates.push(join(root, dir, sub));
			}
		}
	}

	const found = candidates.find((p) => p && existsSync(p));
	if (!found) {
		console.error(
			'Chromium not found.\n' +
				'  Run: bunx playwright install chromium\n' +
				'  Or point at an existing build: HEZO_CHROMIUM_PATH=/path/to/chrome',
		);
		process.exit(1);
	}
	return found;
}

/**
 * The guard that makes the original truncation unrepeatable. A wrong-sized or
 * partially-painted canvas fails here instead of being committed.
 */
function assertPainted(buf: Buffer, target: IconTarget): void {
	const img = decodePng(buf);
	const { file, size, fullBleed } = target;
	if (img.width !== size || img.height !== size) {
		throw new Error(`${file}: expected ${size}x${size}, got ${img.width}x${img.height}`);
	}
	if (fullBleed) {
		const a = minAlpha(img);
		if (a !== 255)
			throw new Error(`${file}: full-bleed variant has a transparent pixel (min alpha ${a})`);
		return;
	}
	if (target.variant === 'monochrome') return; // alpha-only by design; bounds checked in the test
	const b = opaqueBounds(img);
	if (b.x0 !== 0 || b.y0 !== 0 || b.x1 !== size - 1 || b.y1 !== size - 1) {
		throw new Error(
			`${file}: artwork spans ${b.x0},${b.y0}-${b.x1},${b.y1} but should reach ${size - 1} on both axes - truncated`,
		);
	}
}

async function main(): Promise<void> {
	const program = new Command()
		.name('generate-icons')
		.description('Regenerate the PWA icon bitmaps from brand/icon-geometry.ts')
		.option('--out <dir>', 'output directory', DEFAULT_OUT)
		.option('--chromium <path>', 'explicit Chromium executable')
		.parse();
	const opts = program.opts<{ out: string; chromium?: string }>();

	const outDir = resolve(opts.out);
	mkdirSync(outDir, { recursive: true });

	const executablePath = resolveChromium(opts.chromium);
	const browser = await chromium.launch({
		executablePath,
		args: ['--force-color-profile=srgb', '--disable-lcd-text'],
	});

	try {
		for (const target of ICON_TARGETS) {
			const { file, variant, size } = target;
			// A context per size renders each bitmap natively - no downscale, no crop.
			const context = await browser.newContext({
				viewport: { width: size, height: size },
				deviceScaleFactor: 1,
			});
			const page = await context.newPage();
			await page.setContent(
				'<!doctype html><meta charset="utf-8">' +
					`<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>` +
					iconSvg(variant),
			);
			const buf = await page.screenshot({ omitBackground: true, type: 'png' });
			await context.close();

			assertPainted(buf, target);
			writeFileSync(join(outDir, file), buf);
			console.log(`  ${file.padEnd(26)} ${size}x${size}  ${String(buf.length).padStart(6)} bytes`);
		}
	} finally {
		await browser.close();
	}

	console.log(`\n${ICON_TARGETS.length} icons written to ${outDir}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});

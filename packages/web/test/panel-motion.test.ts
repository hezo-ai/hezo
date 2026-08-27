import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANEL_MOTION_MS } from '../src/lib/panel-motion';

/**
 * The beat is spelled twice by necessity: the browser animates on
 * `--panel-motion` in index.css, and the timers that keep a closing panel
 * mounted need the number in JS. A JS timer shorter than the CSS animation
 * unmounts the panel mid-fade and flickers on every close, and nothing else
 * would catch it — so pin the two together here.
 */
describe('panel motion', () => {
	const css = readFileSync(join(__dirname, '../src/index.css'), 'utf-8');

	it('declares --panel-motion at the duration the JS timers use', () => {
		const match = css.match(/--panel-motion:\s*(\d+)ms/);
		expect(match?.[1]).toBe(String(PANEL_MOTION_MS));
	});

	it('guards the panel animations behind prefers-reduced-motion', () => {
		const guard = css
			.split('@media (prefers-reduced-motion: reduce)')
			.some((block) => block.includes('.panel-enter') && block.includes('animation: none'));
		expect(guard).toBe(true);
	});
});

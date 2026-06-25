import { describe, expect, it } from 'vitest';
import {
	type BrowserAvailabilityInput,
	browserAvailable,
	browserOpenCommand,
} from '../src/lib/open-browser';

const base: BrowserAvailabilityInput = {
	platform: 'darwin',
	env: {},
	hasDockerEnv: false,
};

describe('browserAvailable', () => {
	it('reports available on desktop platforms', () => {
		expect(browserAvailable({ ...base, platform: 'darwin' }).available).toBe(true);
		expect(browserAvailable({ ...base, platform: 'win32' }).available).toBe(true);
		// Linux with a display present is fine.
		expect(browserAvailable({ ...base, platform: 'linux', env: { DISPLAY: ':0' } }).available).toBe(
			true,
		);
		expect(
			browserAvailable({ ...base, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })
				.available,
		).toBe(true);
	});

	it('skips in CI regardless of platform', () => {
		const r = browserAvailable({ ...base, env: { CI: 'true' } });
		expect(r.available).toBe(false);
		expect(r.reason).toMatch(/CI/);
	});

	it('skips inside a container (dockerenv or container env)', () => {
		expect(browserAvailable({ ...base, hasDockerEnv: true }).available).toBe(false);
		const r = browserAvailable({ ...base, env: { container: 'podman' } });
		expect(r.available).toBe(false);
		expect(r.reason).toMatch(/container/);
	});

	it('skips over SSH sessions', () => {
		for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
			const r = browserAvailable({ ...base, env: { [key]: 'x' } });
			expect(r.available).toBe(false);
			expect(r.reason).toMatch(/SSH/);
		}
	});

	it('skips on headless Linux with no display', () => {
		const r = browserAvailable({ ...base, platform: 'linux', env: {} });
		expect(r.available).toBe(false);
		expect(r.reason).toMatch(/display/);
	});

	it('does not require a display on macOS/Windows', () => {
		expect(browserAvailable({ ...base, platform: 'darwin', env: {} }).available).toBe(true);
		expect(browserAvailable({ ...base, platform: 'win32', env: {} }).available).toBe(true);
	});
});

describe('browserOpenCommand', () => {
	it('picks the platform launcher', () => {
		expect(browserOpenCommand('darwin', 'http://x')).toEqual(['open', 'http://x']);
		expect(browserOpenCommand('win32', 'http://x')).toEqual([
			'cmd',
			'/c',
			'start',
			'""',
			'http://x',
		]);
		expect(browserOpenCommand('linux', 'http://x')).toEqual(['xdg-open', 'http://x']);
	});
});

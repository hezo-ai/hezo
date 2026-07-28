import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	clearStartupFailure,
	readStartupFailure,
	recordStartupFailure,
} from '../src/startup-failure';

// The fatal startup errors exit(1), and `Restart=always` brings the process
// straight back to fail identically — so the reason has to outlive the process
// or the operator only ever sees the boot screen looping.

describe('startup failure breadcrumb', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	function tempDir(): string {
		const d = mkdtempSync(join(tmpdir(), 'hezo-startup-failure-'));
		dirs.push(d);
		return d;
	}

	it('round-trips a failure to the next boot', () => {
		const dir = tempDir();
		recordStartupFailure(dir, {
			message: 'Migration 046_add_local_model_providers.sql failed',
			phase: 'migrations',
			version: '0.36.0',
		});

		const read = readStartupFailure(dir);
		expect(read?.message).toBe('Migration 046_add_local_model_providers.sql failed');
		expect(read?.phase).toBe('migrations');
		expect(read?.version).toBe('0.36.0');
		expect(Number.isNaN(Date.parse(read?.at ?? ''))).toBe(false);
	});

	it('reports nothing when the previous boot was clean', () => {
		expect(readStartupFailure(tempDir())).toBeNull();
	});

	it('clears the breadcrumb once a boot succeeds', () => {
		const dir = tempDir();
		recordStartupFailure(dir, { message: 'boom', phase: 'database', version: '0.36.0' });
		expect(readStartupFailure(dir)).not.toBeNull();

		clearStartupFailure(dir);
		expect(readStartupFailure(dir)).toBeNull();
		// Clearing an already-clean data dir must stay a no-op, not throw.
		expect(() => clearStartupFailure(dir)).not.toThrow();
	});

	it('ignores a truncated or hand-edited breadcrumb rather than breaking the boot screen', () => {
		const dir = tempDir();
		writeFileSync(join(dir, '.last-startup-error.json'), '{"message":', 'utf-8');
		expect(readStartupFailure(dir)).toBeNull();

		writeFileSync(join(dir, '.last-startup-error.json'), '{"message":""}', 'utf-8');
		expect(readStartupFailure(dir)).toBeNull();
	});

	it('never throws when the data dir cannot be written', () => {
		expect(() =>
			recordStartupFailure(join(tempDir(), 'does', 'not', 'exist'), {
				message: 'boom',
				phase: 'migrations',
				version: '0.36.0',
			}),
		).not.toThrow();
	});
});

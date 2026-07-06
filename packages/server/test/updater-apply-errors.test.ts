import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyStagedUpdate, UpdateApplyError } from '../src/services/updater';

// Simulate an install directory the current user cannot write to. Tests run as
// root in some environments (where a chmod-based EACCES cannot be provoked), so
// the permission failure is injected at the fs layer: copyFile onto any path
// containing the marker fails with EACCES, everything else passes through.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		copyFile: async (
			src: Parameters<typeof actual.copyFile>[0],
			dest: Parameters<typeof actual.copyFile>[1],
			mode?: number,
		) => {
			if (String(dest).includes('eacces-install-dir')) {
				const e: NodeJS.ErrnoException = Object.assign(
					new Error(`EACCES: permission denied, copyfile -> '${String(dest)}'`),
					{ code: 'EACCES' },
				);
				throw e;
			}
			return actual.copyFile(src, dest, mode);
		},
	};
});

describe('applyStagedUpdate permission failures', () => {
	it('maps EACCES on the adjacent copy to an operator-actionable UpdateApplyError', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hezo-apply-eacces-'));
		try {
			const dataDir = join(dir, 'data');
			await mkdir(join(dataDir, '.update'), { recursive: true });
			await writeFile(join(dataDir, '.update', 'staged'), 'new binary bytes');

			const installDir = join(dir, 'eacces-install-dir');
			await mkdir(installDir, { recursive: true });
			const target = join(installDir, 'hezo');
			await writeFile(target, 'ORIGINAL');

			const attempt = applyStagedUpdate(dataDir, target);
			attempt.catch(() => {}); // avoid an unhandled-rejection blip between the two awaits
			await expect(attempt).rejects.toBeInstanceOf(UpdateApplyError);
			await expect(attempt).rejects.toThrow(/not writable by this user/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

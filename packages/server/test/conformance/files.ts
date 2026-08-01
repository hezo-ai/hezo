/**
 * `SandboxFiles` conformance: the file contract every backend must satisfy,
 * run against a real one.
 *
 * This interface is what makes a whole agent run possible rather than just its
 * container lifecycle - every artefact a run stages (the prompt, the per-run
 * runtime home and its credentials, the tunnel config) and every one it reads
 * back (Grok's debug log, Kimi's `wire.jsonl`, the push-error log) goes through
 * it. Its divergences are also the quietest: a `removeDir` that no-ops looks
 * exactly like one that worked, and on the backend where it no-opped it left the
 * provider credential on the provider's disk.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxFiles } from '../../src/services/sandbox/files';
import {
	CONFORMANCE_LABEL,
	conformanceRunId,
	type LiveAdapterFixture,
	sweepConformanceContainers,
} from './fixture';

/** Registers the file-contract conformance suite for one backend. */
export function describeFilesConformance(fixture: LiveAdapterFixture): void {
	describe(`${fixture.name}: SandboxFiles conformance`, () => {
		const engine = fixture.engine;
		let containerId: string;
		let files: SandboxFiles;

		beforeAll(async () => {
			await sweepConformanceContainers(engine);
			const created = await engine.createContainer(`hezo-conf-files-${conformanceRunId()}`, {
				Image: fixture.image,
				// PID 1 has to outlive the execs, exactly as production sets it
				// (`containers.ts`). Without it the container runs the image's default
				// command, exits immediately, and every assertion below fails on a dead
				// container rather than on the thing it was testing.
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);
			files = engine.files(containerId, fixture.workRoot);
			await files.mkdir('.');
		}, 300_000);

		afterAll(async () => {
			await sweepConformanceContainers(engine);
		}, 120_000);

		it('round-trips text through the container', async () => {
			await files.write('hello.txt', 'from the conformance suite');
			expect(await files.read('hello.txt')).toBe('from the conformance suite');
		});

		it('round-trips bytes without mangling them', async () => {
			// Every byte value, NUL included: a transport that base64s, or one that
			// treats the payload as text, corrupts a runtime credential silently.
			const payload = new Uint8Array(256);
			for (let i = 0; i < 256; i++) payload[i] = i;
			await files.writeBytes('bytes.bin', payload);
			const back = await files.readBytes('bytes.bin');
			expect(Array.from(back)).toEqual(Array.from(payload));
		});

		it('answers exists for a file, a directory, and neither', async () => {
			// A directory is the case that diverged: built on a download, asking
			// about one was an error rather than a "yes".
			await files.write('present.txt', 'x');
			await files.mkdir('adir');
			expect(await files.exists('present.txt')).toBe(true);
			expect(await files.exists('adir')).toBe(true);
			expect(await files.exists('nothing-here.txt')).toBe(false);
		});

		it('reports a size without transferring the file, and null for a directory', async () => {
			await files.write('sized.txt', 'abcde');
			expect(await files.size('sized.txt')).toBe(5);
			await files.mkdir('sizedir');
			expect(await files.size('sizedir')).toBeNull();
			expect(await files.size('absent.txt')).toBeNull();
		});

		it('lists a directory, and answers empty rather than throwing for a missing one', async () => {
			await files.mkdir('listing');
			await files.write('listing/a.txt', 'a');
			await files.write('listing/b.txt', 'b');
			expect((await files.list('listing')).sort()).toEqual(['a.txt', 'b.txt']);
			expect(await files.list('no-such-dir')).toEqual([]);
		});

		it('creates missing parents on write', async () => {
			// Callers stage into per-run trees that do not exist yet; a write that
			// requires the caller to walk the chain first would be a different
			// contract on every backend.
			await files.write('deep/nested/tree/file.txt', 'ok');
			expect(await files.read('deep/nested/tree/file.txt')).toBe('ok');
		});

		it('applies the mode it was asked for', async () => {
			// The credential contract: 0600 on the secret, 0711 on the directories
			// above it so a deprivileged run user can traverse without listing.
			// Dropping it either locks the run out or widens a credential to
			// world-readable, and neither fails loudly.
			await files.write('secret/creds.json', '{"token":"x"}', { mode: 0o600, dirMode: 0o711 });
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', `stat -c %a ${fixture.workRoot}/secret/creds.json`],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(execId)).stdout.trim()).toBe('600');
		});

		it('removes a non-empty directory rather than leaving it in place', async () => {
			// The scrub, not tidying: this tree holds the run's provider credential.
			// A backend whose delete refuses a populated directory and swallows the
			// refusal leaves that credential behind while reporting success.
			await files.write('scrubme/.config/creds.json', '{"token":"x"}');
			await files.write('scrubme/other.txt', 'y');
			expect(await files.exists('scrubme/.config/creds.json')).toBe(true);

			await files.removeDir('scrubme');
			expect(await files.exists('scrubme/.config/creds.json')).toBe(false);
			expect(await files.exists('scrubme')).toBe(false);
		});

		it('treats removing something absent as a no-op, not an error', async () => {
			await files.remove('never-existed.txt');
			await files.removeDir('never-existed-dir');
		});

		it('finds a file by name below a directory', async () => {
			await files.write('search/one/target.log', 'a');
			await files.write('search/two/three/target.log', 'b');
			const found = await files.findByName('search', 'target.log', 5);
			expect(found.length).toBe(2);
			// Paths come back relative to the root, matching the host implementation.
			for (const p of found) expect(p.startsWith('/')).toBe(false);
		});

		it('refuses a path that escapes its root', async () => {
			// The root is the sandbox boundary this interface exists to enforce; a
			// caller that can climb out of it can read the operator's own disk on a
			// bind-mounted backend.
			await expect(files.read('../../../etc/passwd')).rejects.toThrow();
			await expect(files.write('../escape.txt', 'no')).rejects.toThrow();
		});

		it('a write is visible to a command running in the container', async () => {
			// The point of the whole interface: staging through it must be the same
			// bytes the agent process sees, not a parallel store that looks right.
			await files.write('visible.txt', 'seen-by-exec');
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', `cat ${fixture.workRoot}/visible.txt`],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(execId)).stdout).toContain('seen-by-exec');
		});

		it('a file a command writes is readable through the interface', async () => {
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', `echo written-by-exec > ${fixture.workRoot}/from-exec.txt`],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			await engine.execStart(execId);
			expect(await files.read('from-exec.txt')).toContain('written-by-exec');
		});
	});
}

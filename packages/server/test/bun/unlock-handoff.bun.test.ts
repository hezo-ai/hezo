import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupervisorUnlockKeyStore, isUnlockKeyMessage } from '../../src/lib/unlock-handoff';

// Runtime tier: the unlock-key handoff rides Bun.spawn's IPC channel between
// two bun processes with `serialization: 'json'` — behaviour vitest (Node)
// cannot exercise. This spawns a real child that plays the worker's part with
// the wire format spelled out INLINE (not via the shared builders), so the test
// pins the on-the-wire JSON shape: after an update the supervisor still runs
// the OLD binary's code against the new worker, so the format must never drift.

const KEY = 'ab'.repeat(32);

// Simulated worker: push the key at "unlock time", then request it back as a
// freshly relaunched locked worker would, and echo any reply so the parent can
// observe the full round trip.
const CHILD_SOURCE = `
process.on('message', (m) => {
	if (m && m.type === 'hezo:unlock-key') {
		process.send({ type: 'echo', unlockKeyHex: m.unlockKeyHex });
	}
});
process.send({ type: 'hezo:unlock-key', unlockKeyHex: '${KEY}' });
process.send({ type: 'hezo:request-unlock-key' });
`;

describe('unlock-key handoff over real Bun IPC', () => {
	test('push → store → request → reply round-trips between two bun processes', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hezo-ipc-'));
		const script = join(dir, 'worker.js');
		await writeFile(script, CHILD_SOURCE);

		const store = createSupervisorUnlockKeyStore();
		const received: unknown[] = [];
		let resolveEcho!: (key: string) => void;
		const echoed = new Promise<string>((resolve) => {
			resolveEcho = resolve;
		});

		const child = Bun.spawn([process.execPath, script], {
			stdout: 'ignore',
			stderr: 'ignore',
			serialization: 'json',
			ipc(message, subprocess) {
				received.push(message);
				// The supervisor's actual message routing: store pushes, answer requests.
				store.handleMessage(message, (reply) => subprocess.send(reply));
				const m = message as { type?: unknown; unlockKeyHex?: unknown };
				if (m?.type === 'echo' && typeof m.unlockKeyHex === 'string') {
					resolveEcho(m.unlockKeyHex);
				}
			},
		});

		try {
			// The child received the store's reply and echoed the key back — the
			// whole worker→supervisor→worker cycle over the real channel.
			expect(await echoed).toBe(KEY);
			// The inline-format push parsed with the real guard: wire format matches.
			expect(received.some((m) => isUnlockKeyMessage(m) && m.unlockKeyHex === KEY)).toBe(true);
		} finally {
			child.kill();
			await child.exited;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

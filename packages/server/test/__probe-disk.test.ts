/** Temporary review probe - deleted after measuring. */
import { it } from 'vitest';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../src/services/sandbox/daytona/engine';

const key = process.env.HEZO_DAYTONA_API_KEY as string;

it('daytona mount layout', async () => {
	const client = new DaytonaClient(key);
	const engine = new DaytonaEngine(client);
	const note = (s: string) => console.log(`DISK: ${s}`);
	let id = '';
	try {
		const created = await engine.createContainer('hezo-disk-probe', {
			Image: 'ghcr.io/hezo-ai/agent-base:latest',
			Env: [],
			Labels: { 'hezo.probe': 'review-880-disk' },
			HostConfig: { Memory: 2 * 1024 ** 3 },
		});
		id = created.Id;
		const sandbox = (await client.getSandbox(id))!;
		const out = await client.execute(
			sandbox,
			'mkdir -p /workspace; echo "dev_root=$(stat -c %d / 2>/dev/null)"; ' +
				'echo "dev_ws=$(stat -c %d /workspace 2>/dev/null)"; ' +
				'echo "--- df ---"; df -Pk / /workspace 2>&1',
		);
		note(out.output);
		note(`engine.diskUsedBytes(/workspace) => ${await engine.diskUsedBytes(id, '/workspace')}`);
	} finally {
		if (id) await engine.removeContainer(id).catch(() => undefined);
		note('destroyed');
	}
}, 200_000);

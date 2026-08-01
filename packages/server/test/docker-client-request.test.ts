import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerClient, MEMORY_HARD_CAP_HEADROOM_BYTES } from '../src/services/docker';
import { startDockerSockSim } from './helpers/docker-sock-sim';

// The DockerClient's one-shot calls ride `fetch` with Bun's `unix` option; under
// vitest (Node) that option is inert, so these tests stub the global fetch to
// script daemon responses and pin the client's request construction, status
// mapping, JSON parsing, and error surfacing. The long-lived streams (node:http)
// are pinned in docker-stream-transport.test.ts / test/bun/docker-stream.bun.test.ts;
// the demux section at the bottom drives the real unix-socket transport.

interface RecordedCall {
	url: string;
	method: string;
	body?: string;
	unix?: string;
	contentType?: string;
}

type FetchHandler = (
	url: string,
	init: RequestInit & { unix?: string },
) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): RecordedCall[] {
	const calls: RecordedCall[] = [];
	vi.stubGlobal('fetch', (async (
		input: RequestInfo | URL,
		init?: RequestInit & { unix?: string },
	) => {
		const url = String(input);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url,
			method: init?.method ?? 'GET',
			body: typeof init?.body === 'string' ? init.body : undefined,
			unix: init?.unix,
			contentType: headers['Content-Type'],
		});
		return handler(url, init ?? {});
	}) as typeof fetch);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const SOCK = '/tmp/hezo-fake-docker.sock';
const client = () => new DockerClient(SOCK);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const text = (body: string, status = 200) => new Response(body, { status });
const empty = (status: number) => new Response(null, { status });

describe('request transport', () => {
	it('addresses the daemon through the unix socket with the pinned API version', async () => {
		const calls = stubFetch(() => text('OK'));
		await expect(client().ping()).resolves.toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('http://localhost/v1.44/_ping');
		expect(calls[0].method).toBe('GET');
		expect(calls[0].unix).toBe(SOCK);
		expect(calls[0].contentType).toBeUndefined();
	});

	it('defaults to the standard docker socket path', async () => {
		const calls = stubFetch(() => text('OK'));
		await new DockerClient().ping();
		expect(calls[0].unix).toBe('/var/run/docker.sock');
	});

	it('ping returns false on a non-ok status and on transport failure', async () => {
		stubFetch(() => text('unavailable', 500));
		await expect(client().ping()).resolves.toBe(false);
		vi.unstubAllGlobals();

		stubFetch(() => {
			throw new Error('ECONNREFUSED');
		});
		await expect(client().ping()).resolves.toBe(false);
	});
});

describe('image operations', () => {
	it('imageExists maps ok → true and encodes the image reference', async () => {
		const calls = stubFetch(() => json({ Id: 'sha256:abc' }));
		await expect(client().imageExists('hezo/agent-base:latest')).resolves.toBe(true);
		expect(calls[0].url).toBe('http://localhost/v1.44/images/hezo%2Fagent-base%3Alatest/json');
	});

	it('imageExists maps 404 → false', async () => {
		stubFetch(() => json({ message: 'no such image' }, 404));
		await expect(client().imageExists('ghost:latest')).resolves.toBe(false);
	});

	it('inspectImage parses the payload, maps 404 → null, and throws on errors', async () => {
		stubFetch(() => json({ Id: 'sha256:abc', Config: { Labels: { a: 'b' } } }));
		await expect(client().inspectImage('img')).resolves.toEqual({
			Id: 'sha256:abc',
			Config: { Labels: { a: 'b' } },
		});
		vi.unstubAllGlobals();

		stubFetch(() => json({ message: 'nope' }, 404));
		await expect(client().inspectImage('img')).resolves.toBeNull();
		vi.unstubAllGlobals();

		stubFetch(() => text('daemon exploded', 500));
		await expect(client().inspectImage('img')).rejects.toThrow(
			'Docker inspectImage failed (500): daemon exploded',
		);
	});

	it('inspectImage rejects an empty 200 body with a diagnostic', async () => {
		stubFetch(() => text('   '));
		await expect(client().inspectImage('img')).rejects.toThrow(
			'Docker inspectImage returned empty body (status=200)',
		);
	});

	it('inspectImage rejects a non-JSON body with a snippet', async () => {
		stubFetch(() => text('<html>proxy error</html>'));
		await expect(client().inspectImage('img')).rejects.toThrow(
			'Docker inspectImage returned non-JSON (status=200): <html>proxy error</html>',
		);
	});

	it('truncates long non-JSON bodies to a 200-char snippet', async () => {
		stubFetch(() => text('x'.repeat(250)));
		const err = await client()
			.inspectImage('img')
			.then(
				() => null,
				(e: Error) => e,
			);
		expect(err).toBeInstanceOf(Error);
		expect(err?.message).toContain(`${'x'.repeat(200)}…`);
		expect(err?.message).not.toContain('x'.repeat(201));
	});

	it('removeImage passes force/noprune flags and tolerates 404', async () => {
		const calls = stubFetch(() => empty(204));
		await client().removeImage('img:tag', true);
		expect(calls[0].url).toBe('http://localhost/v1.44/images/img%3Atag?force=true&noprune=false');
		expect(calls[0].method).toBe('DELETE');
		vi.unstubAllGlobals();

		const dflt = stubFetch(() => empty(204));
		await client().removeImage('img:tag');
		expect(dflt[0].url).toContain('force=false');
		vi.unstubAllGlobals();

		stubFetch(() => json({ message: 'no such image' }, 404));
		await expect(client().removeImage('img:tag')).resolves.toBeUndefined();
		vi.unstubAllGlobals();

		stubFetch(() => text('image is in use', 409));
		await expect(client().removeImage('img:tag')).rejects.toThrow(
			'Docker removeImage failed (409): image is in use',
		);
	});

	it('pullImage posts to images/create and throws on failure', async () => {
		const calls = stubFetch(() => text('{"status":"pulled"}'));
		await client().pullImage('ghcr.io/hezo-ai/agent-base:latest');
		expect(calls[0].method).toBe('POST');
		expect(calls[0].url).toBe(
			'http://localhost/v1.44/images/create?fromImage=ghcr.io%2Fhezo-ai%2Fagent-base%3Alatest',
		);
		vi.unstubAllGlobals();

		stubFetch(() => text('manifest unknown', 404));
		await expect(client().pullImage('ghost:latest')).rejects.toThrow(
			'Docker pullImage failed (404): manifest unknown',
		);
	});
});

describe('network inspection', () => {
	it('inspectNetwork parses IPAM config, maps 404 → null, and throws on errors', async () => {
		const calls = stubFetch(() =>
			json({ IPAM: { Config: [{ Gateway: '172.17.0.1', Subnet: '172.17.0.0/16' }] } }),
		);
		await expect(client().inspectNetwork('bridge')).resolves.toEqual({
			IPAM: { Config: [{ Gateway: '172.17.0.1', Subnet: '172.17.0.0/16' }] },
		});
		expect(calls[0].url).toBe('http://localhost/v1.44/networks/bridge');
		vi.unstubAllGlobals();

		stubFetch(() => json({ message: 'not found' }, 404));
		await expect(client().inspectNetwork('missing')).resolves.toBeNull();
		vi.unstubAllGlobals();

		stubFetch(() => text('boom', 500));
		await expect(client().inspectNetwork('bridge')).rejects.toThrow(
			'Docker inspectNetwork failed (500): boom',
		);
	});
});

describe('container lifecycle operations', () => {
	it('createContainer posts the config with the name query and returns the parsed result', async () => {
		const calls = stubFetch(() => json({ Id: 'cid-1', Warnings: ['w'] }, 201));
		const res = await client().createContainer('hezo-demo-1234', {
			Image: 'img',
			HostConfig: {},
		});
		expect(res).toEqual({ Id: 'cid-1', Warnings: ['w'] });
		expect(calls[0].url).toBe('http://localhost/v1.44/containers/create?name=hezo-demo-1234');
		expect(calls[0].contentType).toBe('application/json');
		expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ Image: 'img', HostConfig: {} });
	});

	it('createContainer throws with the daemon message on conflict', async () => {
		stubFetch(() => text('name already in use', 409));
		await expect(client().createContainer('dup', { Image: 'img', HostConfig: {} })).rejects.toThrow(
			'Docker createContainer failed (409): name already in use',
		);
	});

	it('sets the cgroup limit above the ceiling it was given, with no swap escape valve', async () => {
		// The two limits do different jobs. The caller states the project's
		// working-set **ceiling**, which is where the stats poller stops the
		// container gracefully; the cgroup cap sits a little above it so a runaway
		// allocation *between* poll ticks meets the kernel OOM killer rather than
		// taking the operator's host with it.
		//
		// The margin lives here, in the adapter, because it is a cgroup and a
		// shared-host concern and a managed sandbox has neither. It used to be added
		// by the caller, which made *both* backends ask their provider for more
		// memory than the project was configured for - and at the boundary refused a
		// project set to a managed provider's documented maximum, telling the
		// operator to lower a limit they had set to the advertised value.
		const calls = stubFetch(() => json({ Id: 'cid-1', Warnings: [] }, 201));
		const ceiling = 2 * 1024 ** 3;
		await client().createContainer('hezo-demo', {
			Image: 'img',
			HostConfig: { Memory: ceiling, MemorySwap: ceiling },
		});
		const sent = JSON.parse(calls[0].body ?? '{}');
		expect(sent.HostConfig.Memory).toBe(ceiling + MEMORY_HARD_CAP_HEADROOM_BYTES);
		expect(sent.HostConfig.MemorySwap).toBe(sent.HostConfig.Memory);
	});

	it('leaves a config that states no ceiling alone rather than inventing one', async () => {
		const calls = stubFetch(() => json({ Id: 'cid-1', Warnings: [] }, 201));
		await client().createContainer('hezo-demo', { Image: 'img', HostConfig: {} });
		expect(JSON.parse(calls[0].body ?? '{}').HostConfig).toEqual({});
	});

	it('startContainer succeeds on 204, tolerates 304, and throws otherwise', async () => {
		const calls = stubFetch(() => empty(204));
		await client().startContainer('cid-1');
		expect(calls[0].url).toBe('http://localhost/v1.44/containers/cid-1/start');
		expect(calls[0].method).toBe('POST');
		vi.unstubAllGlobals();

		stubFetch(() => empty(304));
		await expect(client().startContainer('cid-1')).resolves.toBeUndefined();
		vi.unstubAllGlobals();

		stubFetch(() => text('no such container', 404));
		await expect(client().startContainer('cid-1')).rejects.toThrow(
			'Docker startContainer failed (404): no such container',
		);
	});

	it('stopContainer passes the timeout, tolerates 304, and throws otherwise', async () => {
		const calls = stubFetch(() => empty(204));
		await client().stopContainer('cid-1');
		expect(calls[0].url).toBe('http://localhost/v1.44/containers/cid-1/stop?t=10');
		vi.unstubAllGlobals();

		const custom = stubFetch(() => empty(204));
		await client().stopContainer('cid-1', 3);
		expect(custom[0].url).toContain('/stop?t=3');
		vi.unstubAllGlobals();

		stubFetch(() => empty(304));
		await expect(client().stopContainer('cid-1')).resolves.toBeUndefined();
		vi.unstubAllGlobals();

		stubFetch(() => text('cannot stop', 500));
		await expect(client().stopContainer('cid-1')).rejects.toThrow(
			'Docker stopContainer failed (500): cannot stop',
		);
	});

	it('removeContainer passes force + volume flags, tolerates 404, and throws otherwise', async () => {
		const calls = stubFetch(() => empty(204));
		await client().removeContainer('cid-1', true);
		expect(calls[0].url).toBe('http://localhost/v1.44/containers/cid-1?force=true&v=true');
		expect(calls[0].method).toBe('DELETE');
		vi.unstubAllGlobals();

		stubFetch(() => json({ message: 'gone' }, 404));
		await expect(client().removeContainer('cid-1')).resolves.toBeUndefined();
		vi.unstubAllGlobals();

		stubFetch(() => text('removal already in progress', 409));
		await expect(client().removeContainer('cid-1')).rejects.toThrow(
			'Docker removeContainer failed (409): removal already in progress',
		);
	});

	it('inspectContainer parses state, maps 404 → null, and throws on errors', async () => {
		const info = {
			Id: 'cid-1',
			State: { Status: 'running', Running: true, Pid: 42, ExitCode: 0 },
			Config: { Image: 'img' },
		};
		stubFetch(() => json(info));
		await expect(client().inspectContainer('cid-1')).resolves.toEqual(info);
		vi.unstubAllGlobals();

		stubFetch(() => json({ message: 'no such container' }, 404));
		await expect(client().inspectContainer('cid-1')).resolves.toBeNull();
		vi.unstubAllGlobals();

		stubFetch(() => text('daemon busy', 500));
		await expect(client().inspectContainer('cid-1')).rejects.toThrow(
			'Docker inspectContainer failed (500): daemon busy',
		);
	});
});

describe('findContainerByNamePrefix', () => {
	const prefix = 'hezo-app-abcd1234';

	it('filters by name, requires the random-suffix separator, and inspects the match', async () => {
		const info = {
			Id: 'cid-match',
			State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
			Config: { Image: 'img' },
		};
		const calls = stubFetch((url) => {
			if (url.includes('/containers/json')) {
				return json([
					// Suffix-less name: prefix matches as a substring but not our container.
					{ Id: 'cid-other', Names: [`/${prefix}extra-ffff0000`] },
					{ Id: 'cid-match', Names: [`/${prefix}-deadbeef`] },
				]);
			}
			if (url.includes('/containers/cid-match/json')) return json(info);
			return text('unexpected route', 500);
		});

		await expect(client().findContainerByNamePrefix(prefix)).resolves.toEqual(info);
		const listUrl = calls[0].url;
		expect(listUrl).toContain('/containers/json?all=true&filters=');
		expect(decodeURIComponent(listUrl.split('filters=')[1])).toBe(
			JSON.stringify({ name: [prefix] }),
		);
	});

	it('returns null when nothing carries the prefix with a suffix separator', async () => {
		stubFetch(() => json([{ Id: 'cid-1', Names: [`/${prefix}longer-suffix0`] }]));
		await expect(client().findContainerByNamePrefix(prefix)).resolves.toBeNull();
	});

	it('returns null for an empty container list', async () => {
		stubFetch(() => json([]));
		await expect(client().findContainerByNamePrefix(prefix)).resolves.toBeNull();
	});

	it('throws when the list call fails', async () => {
		stubFetch(() => text('daemon busy', 500));
		await expect(client().findContainerByNamePrefix(prefix)).rejects.toThrow(
			'Docker listContainers failed (500): daemon busy',
		);
	});
});

describe('listContainersByLabel', () => {
	it('filters by label and returns the raw list', async () => {
		const list = [
			{ Id: 'cid-1', Names: ['/hezo-app-abcd1234-deadbeef'] },
			{ Id: 'cid-2', Names: ['/hezo-web-11112222-cafebabe'] },
		];
		const calls = stubFetch(() => json(list));
		await expect(client().listContainersByLabel('hezo.team')).resolves.toEqual(list);
		const listUrl = calls[0].url;
		expect(listUrl).toContain('/containers/json?all=true&filters=');
		expect(decodeURIComponent(listUrl.split('filters=')[1])).toBe(
			JSON.stringify({ label: ['hezo.team'] }),
		);
	});

	it('returns an empty array when nothing carries the label', async () => {
		stubFetch(() => json([]));
		await expect(client().listContainersByLabel('hezo.team')).resolves.toEqual([]);
	});

	it('throws when the list call fails', async () => {
		stubFetch(() => text('daemon busy', 500));
		await expect(client().listContainersByLabel('hezo.team')).rejects.toThrow(
			'Docker listContainers failed (500): daemon busy',
		);
	});
});

describe('containerStats', () => {
	const statsUrl = (url: string) => url.includes('/stats?stream=false');

	it('computes used bytes as raw usage minus inactive file pages', async () => {
		const calls = stubFetch(() =>
			json({ memory_stats: { usage: 1000, stats: { inactive_file: 300 } } }),
		);
		await expect(client().containerStats('cid-1')).resolves.toEqual({
			usedBytes: 700,
			rawUsageBytes: 1000,
		});
		expect(statsUrl(calls[0].url)).toBe(true);
	});

	it('falls back to total_inactive_file, then cache, then zero', async () => {
		stubFetch(() => json({ memory_stats: { usage: 1000, stats: { total_inactive_file: 250 } } }));
		await expect(client().containerStats('cid-1')).resolves.toEqual({
			usedBytes: 750,
			rawUsageBytes: 1000,
		});
		vi.unstubAllGlobals();

		stubFetch(() => json({ memory_stats: { usage: 1000, stats: { cache: 100 } } }));
		await expect(client().containerStats('cid-1')).resolves.toEqual({
			usedBytes: 900,
			rawUsageBytes: 1000,
		});
		vi.unstubAllGlobals();

		stubFetch(() => json({ memory_stats: { usage: 1000 } }));
		await expect(client().containerStats('cid-1')).resolves.toEqual({
			usedBytes: 1000,
			rawUsageBytes: 1000,
		});
	});

	it('clamps used bytes at zero when reclaimable pages exceed raw usage', async () => {
		stubFetch(() => json({ memory_stats: { usage: 100, stats: { inactive_file: 400 } } }));
		await expect(client().containerStats('cid-1')).resolves.toEqual({
			usedBytes: 0,
			rawUsageBytes: 100,
		});
	});

	it('returns null when usage is missing, the body is empty, or the container is gone', async () => {
		stubFetch(() => json({ memory_stats: {} }));
		await expect(client().containerStats('cid-1')).resolves.toBeNull();
		vi.unstubAllGlobals();

		stubFetch(() => text(''));
		await expect(client().containerStats('cid-1')).resolves.toBeNull();
		vi.unstubAllGlobals();

		stubFetch(() => json({ message: 'no such container' }, 404));
		await expect(client().containerStats('cid-1')).resolves.toBeNull();
	});

	it('throws on daemon errors', async () => {
		stubFetch(() => text('daemon busy', 500));
		await expect(client().containerStats('cid-1')).rejects.toThrow(
			'Docker containerStats failed (500): daemon busy',
		);
	});
});

describe('exec plumbing', () => {
	it('execCreate posts the exec config and returns the exec id', async () => {
		const calls = stubFetch(() => json({ Id: 'exec-9' }, 201));
		const id = await client().execCreate('cid-1', {
			Cmd: ['sh', '-c', 'true'],
			AttachStdout: true,
			AttachStderr: true,
		});
		expect(id).toBe('exec-9');
		expect(calls[0].url).toBe('http://localhost/v1.44/containers/cid-1/exec');
		expect(JSON.parse(calls[0].body ?? '{}').Cmd).toEqual(['sh', '-c', 'true']);
	});

	it('execCreate throws when the container is not running', async () => {
		stubFetch(() => text('container not running', 409));
		await expect(
			client().execCreate('cid-1', { Cmd: ['true'], AttachStdout: true, AttachStderr: true }),
		).rejects.toThrow('Docker execCreate failed (409): container not running');
	});

	it('execInspect parses the exit state and throws on errors', async () => {
		stubFetch(() => json({ ExitCode: 2, Running: false, Pid: 0 }));
		await expect(client().execInspect('exec-9')).resolves.toEqual({
			ExitCode: 2,
			Running: false,
			Pid: 0,
		});
		vi.unstubAllGlobals();

		stubFetch(() => text('no such exec', 404));
		await expect(client().execInspect('exec-9')).rejects.toThrow(
			'Docker execInspect failed (404): no such exec',
		);
	});
});

describe('killRunProcesses', () => {
	// Docker exposes no API to signal an exec'd process, so the run-kill is itself an
	// exec that scans /proc for the run's HEZO_HEARTBEAT_RUN_ID env marker and SIGKILLs
	// every match. Pin the generated script + exec config so the marker, the /proc
	// scan, and the SIGKILL can't silently regress. execCreate/execStart are stubbed on
	// the instance to capture args without any transport.
	it('execs a root /proc-scan that SIGKILLs every process carrying the run marker', async () => {
		const docker = client();
		const created: Array<{ containerId: string; config: Record<string, unknown> }> = [];
		const started: string[] = [];
		docker.execCreate = async (containerId, config) => {
			created.push({ containerId, config: config as unknown as Record<string, unknown> });
			return 'exec-kill';
		};
		docker.execStart = async (execId) => {
			started.push(execId);
			return { stdout: '', stderr: '' };
		};

		await docker.killRunProcesses('cid-1', 'run-abc-123');

		expect(created).toHaveLength(1);
		expect(created[0].containerId).toBe('cid-1');
		const cmd = created[0].config.Cmd as string[];
		expect(cmd[0]).toBe('sh');
		expect(cmd[1]).toBe('-c');
		const script = cmd[2];
		expect(script).toContain('/proc/[0-9]*/environ');
		expect(script).toContain('HEZO_HEARTBEAT_RUN_ID=run-abc-123');
		expect(script).toContain('kill -9');
		// No User field → runs as the container's default user (root), so it can
		// signal the deprivileged run-user's processes.
		expect(created[0].config.User).toBeUndefined();
		expect(created[0].config.AttachStdout).toBe(false);
		expect(created[0].config.AttachStderr).toBe(false);
		expect(started).toEqual(['exec-kill']);
	});

	it('propagates an exec failure to the caller (which treats it as best-effort)', async () => {
		const docker = client();
		docker.execCreate = async () => {
			throw new Error('Docker execCreate failed (409): container not running');
		};
		await expect(docker.killRunProcesses('cid-1', 'run-abc-123')).rejects.toThrow(
			'container not running',
		);
	});
});

describe('killProcessesByEnvMarker', () => {
	it('rejects a shell-active marker value before any exec is created', async () => {
		const docker = client();
		let created = 0;
		docker.execCreate = async () => {
			created++;
			return 'exec-kill';
		};
		for (const value of ['a b', 'a"b', "a'b", 'a$b', 'a`b`', 'a;b', '', 'x'.repeat(65)]) {
			await expect(
				docker.killProcessesByEnvMarker('cid-1', 'HEZO_EXEC_SCOPE_ID', value),
			).rejects.toThrow('unsafe env marker value');
		}
		expect(created).toBe(0);
	});

	it('greps for the exact <name>=<value> marker', async () => {
		const docker = client();
		const scripts: string[] = [];
		docker.execCreate = async (_cid, config) => {
			scripts.push((config.Cmd as string[])[2]);
			return 'exec-kill';
		};
		docker.execStart = async () => ({ stdout: '', stderr: '' });

		await docker.killProcessesByEnvMarker('cid-1', 'HEZO_EXEC_SCOPE_ID', 'scope-42');

		expect(scripts[0]).toContain('HEZO_EXEC_SCOPE_ID=scope-42');
		expect(scripts[0]).toContain('kill -9');
	});
});

describe('listHezoProcesses', () => {
	it('execs a root /proc scan that emits marker/sock/bridge matches with age', async () => {
		const docker = client();
		const created: Array<{ containerId: string; config: Record<string, unknown> }> = [];
		docker.execCreate = async (containerId, config) => {
			created.push({ containerId, config: config as unknown as Record<string, unknown> });
			return 'exec-scan';
		};
		docker.execStart = async () => ({ stdout: '', stderr: '' });

		await docker.listHezoProcesses('cid-1');

		expect(created).toHaveLength(1);
		const cmd = created[0].config.Cmd as string[];
		expect(cmd[0]).toBe('sh');
		const script = cmd[2];
		expect(script).toContain('HEZO_HEARTBEAT_RUN_ID=');
		expect(script).toContain('SSH_AUTH_SOCK=/run/hezo/');
		expect(script).toContain('hezo-run-with-bridge');
		expect(script).toContain('/proc/uptime');
		// Root exec, stdout only (the parseable scan lines).
		expect(created[0].config.User).toBeUndefined();
		expect(created[0].config.AttachStdout).toBe(true);
	});

	it('parses scan output, keeps tab-bearing cmdlines whole, and drops malformed lines', async () => {
		const docker = client();
		docker.execCreate = async () => 'exec-scan';
		docker.execStart = async () => ({
			stdout: [
				'42\trun-uuid-1\t1\t500\tnode /some/cli',
				'43\t\t1\t900\t/bin/sh /usr/local/bin/hezo-ssh-bridge abc host 123',
				// cmdline containing a tab stays one field
				'44\trun-uuid-1\t0\t50\tsh -c echo\thello',
				'45\tbad-age\t0\tnot-a-number\tx',
				'garbage line',
				'',
			].join('\n'),
			stderr: '',
		});

		const procs = await docker.listHezoProcesses('cid-1');

		expect(procs).toEqual([
			{ pid: 42, runId: 'run-uuid-1', hasHezoSock: true, ageSecs: 500, cmdline: 'node /some/cli' },
			{
				pid: 43,
				runId: null,
				hasHezoSock: true,
				ageSecs: 900,
				cmdline: '/bin/sh /usr/local/bin/hezo-ssh-bridge abc host 123',
			},
			{
				pid: 44,
				runId: 'run-uuid-1',
				hasHezoSock: false,
				ageSecs: 50,
				cmdline: 'sh -c echo\thello',
			},
		]);
	});
});

describe('killPids', () => {
	it('SIGKILLs the validated pid list in one exec and no-ops on an empty list', async () => {
		const docker = client();
		const scripts: string[] = [];
		docker.execCreate = async (_cid, config) => {
			scripts.push((config.Cmd as string[])[2]);
			return 'exec-kill';
		};
		docker.execStart = async () => ({ stdout: '', stderr: '' });

		await docker.killPids('cid-1', []);
		expect(scripts).toHaveLength(0);

		await docker.killPids('cid-1', [42, 137, 4096]);
		expect(scripts).toEqual(['kill -9 42 137 4096 2>/dev/null || true']);
	});

	it('rejects non-integer, negative, and PID-1 targets before any exec', async () => {
		const docker = client();
		let created = 0;
		docker.execCreate = async () => {
			created++;
			return 'exec-kill';
		};
		for (const pids of [[1.5], [-1], [Number.NaN], [0], [1]]) {
			await expect(docker.killPids('cid-1', pids)).rejects.toThrow('unsafe pid');
		}
		expect(created).toBe(0);
	});
});

describe('execStart demux over the real unix-socket transport', () => {
	it('concatenates multiple buffered frames per stream', async () => {
		const sim = await startDockerSockSim();
		try {
			const docker = new DockerClient(sim.socketPath);
			sim.onExecStart('multi-frame', {
				frames: [
					{ stream: 'stdout', text: 'alpha ' },
					{ stream: 'stdout', text: 'beta ' },
					{ stream: 'stdout', text: 'gamma' },
					{ stream: 'stderr', text: 'warn-1 ' },
					{ stream: 'stderr', text: 'warn-2' },
				],
			});
			await expect(docker.execStart('multi-frame')).resolves.toEqual({
				stdout: 'alpha beta gamma',
				stderr: 'warn-1 warn-2',
			});
		} finally {
			await sim.close();
		}
	});
});

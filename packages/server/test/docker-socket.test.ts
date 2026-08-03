import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_DOCKER_SOCKET,
	type DockerSocketFs,
	describeDockerSocket,
	dockerSocketCandidates,
	parseDockerHost,
	readCurrentDockerContextSocket,
	resolvedDockerSocketPath,
	runtimeHintFromContextName,
	setResolvedDockerSocket,
	tildePath,
	wellKnownDockerSockets,
} from '../src/services/docker-socket';

const HOME = '/home/tester';

/**
 * In-memory filesystem for the resolver. Files map path → contents; any path
 * listed (or any dir with children) counts as existing.
 */
function fakeFs(
	files: Record<string, string>,
	dirs: Record<string, string[]> = {},
): DockerSocketFs {
	return {
		exists: (path) => path in files,
		readFile: (path) => files[path] ?? null,
		readDir: (path) => dirs[path] ?? [],
	};
}

/** Build the docker CLI's context-store layout for `name` pointing at `host`. */
function contextStore(configDir: string, name: string, host: string): Record<string, string> {
	const digest = createHash('sha256').update(name).digest('hex');
	return {
		[`${configDir}/config.json`]: JSON.stringify({ currentContext: name }),
		[`${configDir}/contexts/meta/${digest}/meta.json`]: JSON.stringify({
			Name: name,
			Endpoints: { docker: { Host: host } },
		}),
	};
}

describe('parseDockerHost', () => {
	it('parses the standard unix:/// form', () => {
		expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({
			kind: 'unix',
			path: '/var/run/docker.sock',
		});
	});

	it('parses the two-slash unix:// form seen in hand-written configs', () => {
		expect(parseDockerHost('unix://home/t/.colima/default/docker.sock')).toEqual({
			kind: 'unix',
			path: '/home/t/.colima/default/docker.sock',
		});
	});

	it('accepts a bare absolute path', () => {
		expect(parseDockerHost('/run/docker.sock')).toEqual({ kind: 'unix', path: '/run/docker.sock' });
	});

	it('trims surrounding whitespace', () => {
		expect(parseDockerHost('  unix:///run/d.sock \n')).toEqual({
			kind: 'unix',
			path: '/run/d.sock',
		});
	});

	it('reports transports Hezo cannot speak instead of silently falling back', () => {
		expect(parseDockerHost('tcp://localhost:2375')).toEqual({ kind: 'unsupported', scheme: 'tcp' });
		expect(parseDockerHost('npipe:////./pipe/docker_engine')).toEqual({
			kind: 'unsupported',
			scheme: 'npipe',
		});
		expect(parseDockerHost('ssh://user@host')).toEqual({ kind: 'unsupported', scheme: 'ssh' });
	});

	it('returns null for unset/blank values', () => {
		expect(parseDockerHost(undefined)).toBeNull();
		expect(parseDockerHost('')).toBeNull();
		expect(parseDockerHost('   ')).toBeNull();
	});
});

describe('runtimeHintFromContextName', () => {
	it('maps the names each runtime installs', () => {
		expect(runtimeHintFromContextName('colima')).toBe('colima');
		expect(runtimeHintFromContextName('colima-work')).toBe('colima');
		expect(runtimeHintFromContextName('rancher-desktop')).toBe('rancher-desktop');
		expect(runtimeHintFromContextName('orbstack')).toBe('orbstack');
		expect(runtimeHintFromContextName('desktop-linux')).toBe('docker-desktop');
		expect(runtimeHintFromContextName('lima-default')).toBe('lima');
	});

	it('returns undefined for a name it does not recognise', () => {
		expect(runtimeHintFromContextName('my-remote')).toBeUndefined();
	});
});

describe('readCurrentDockerContextSocket', () => {
	const sock = `${HOME}/.colima/default/docker.sock`;

	it('reads the current context endpoint from the CLI config store', () => {
		const fs = fakeFs(contextStore(`${HOME}/.docker`, 'colima', `unix://${sock}`));
		expect(readCurrentDockerContextSocket({ env: {}, home: HOME, fs })).toEqual({
			path: sock,
			source: 'docker-context',
			runtime: 'colima',
		});
	});

	it('honours DOCKER_CONTEXT over the config file', () => {
		const fs = fakeFs({
			...contextStore(`${HOME}/.docker`, 'colima', `unix://${sock}`),
			...contextStore(`${HOME}/.docker`, 'orbstack', 'unix:///other/docker.sock'),
			// config.json is written twice above; the last one wins, so pin it explicitly.
			[`${HOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'colima' }),
		});
		const got = readCurrentDockerContextSocket({
			env: { DOCKER_CONTEXT: 'orbstack' },
			home: HOME,
			fs,
		});
		expect(got).toEqual({
			path: '/other/docker.sock',
			source: 'docker-context',
			runtime: 'orbstack',
		});
	});

	it('honours DOCKER_CONFIG for the store location', () => {
		const fs = fakeFs(contextStore('/custom/docker', 'colima', `unix://${sock}`));
		const got = readCurrentDockerContextSocket({
			env: { DOCKER_CONFIG: '/custom/docker' },
			home: HOME,
			fs,
		});
		expect(got?.path).toBe(sock);
	});

	it('skips the built-in default context (it has no meta and means the standard socket)', () => {
		const fs = fakeFs({
			[`${HOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'default' }),
		});
		expect(readCurrentDockerContextSocket({ env: {}, home: HOME, fs })).toBeNull();
	});

	it('returns null rather than throwing on a missing, malformed, or non-unix context', () => {
		expect(readCurrentDockerContextSocket({ env: {}, home: HOME, fs: fakeFs({}) })).toBeNull();

		const badJson = fakeFs({ [`${HOME}/.docker/config.json`]: '{not json' });
		expect(readCurrentDockerContextSocket({ env: {}, home: HOME, fs: badJson })).toBeNull();

		const tcp = fakeFs(contextStore(`${HOME}/.docker`, 'remote', 'tcp://10.0.0.5:2376'));
		expect(readCurrentDockerContextSocket({ env: {}, home: HOME, fs: tcp })).toBeNull();
	});
});

describe('wellKnownDockerSockets', () => {
	it('returns only sockets that exist, in probe order', () => {
		const colima = `${HOME}/.colima/default/docker.sock`;
		const fs = fakeFs(
			{ [DEFAULT_DOCKER_SOCKET]: '', [colima]: '' },
			{ [`${HOME}/.colima`]: ['default'] },
		);
		expect(wellKnownDockerSockets({ env: {}, home: HOME, fs })).toEqual([
			{ path: DEFAULT_DOCKER_SOCKET, source: 'discovered', runtime: 'docker-engine' },
			{ path: colima, source: 'discovered', runtime: 'colima' },
		]);
	});

	it('finds each supported runtime at its own path', () => {
		const cases: Array<[string, string]> = [
			[`${HOME}/.docker/run/docker.sock`, 'docker-desktop'],
			[`${HOME}/.colima/default/docker.sock`, 'colima'],
			[`${HOME}/.rd/docker.sock`, 'rancher-desktop'],
			[`${HOME}/.orbstack/run/docker.sock`, 'orbstack'],
			[`${HOME}/.lima/default/sock/docker.sock`, 'lima'],
		];
		for (const [path, runtime] of cases) {
			const got = wellKnownDockerSockets({ env: {}, home: HOME, fs: fakeFs({ [path]: '' }) });
			expect(got).toEqual([{ path, source: 'discovered', runtime }]);
		}
	});

	it('discovers non-default Colima profiles, default first', () => {
		const base = `${HOME}/.colima`;
		const fs = fakeFs(
			{ [`${base}/work/docker.sock`]: '', [`${base}/default/docker.sock`]: '' },
			{ [base]: ['work', 'default'] },
		);
		expect(wellKnownDockerSockets({ env: {}, home: HOME, fs }).map((c) => c.path)).toEqual([
			`${base}/default/docker.sock`,
			`${base}/work/docker.sock`,
		]);
	});

	it('honours COLIMA_HOME and XDG_RUNTIME_DIR', () => {
		const fs = fakeFs(
			{ '/opt/colima/default/docker.sock': '', '/run/user/1000/docker.sock': '' },
			{ '/opt/colima': ['default'] },
		);
		const got = wellKnownDockerSockets({
			env: { COLIMA_HOME: '/opt/colima', XDG_RUNTIME_DIR: '/run/user/1000' },
			home: HOME,
			fs,
		});
		expect(got.map((c) => c.path)).toEqual([
			'/opt/colima/default/docker.sock',
			'/run/user/1000/docker.sock',
		]);
		expect(got.map((c) => c.runtime)).toEqual(['colima', 'rootless']);
	});

	it('does not auto-discover Podman (untested, must be opted into explicitly)', () => {
		const fs = fakeFs({ '/run/user/1000/podman/podman.sock': '' });
		const got = wellKnownDockerSockets({
			env: { XDG_RUNTIME_DIR: '/run/user/1000' },
			home: HOME,
			fs,
		});
		expect(got).toEqual([]);
	});

	it('returns nothing when no runtime is installed', () => {
		expect(wellKnownDockerSockets({ env: {}, home: HOME, fs: fakeFs({}) })).toEqual([]);
	});
});

describe('dockerSocketCandidates', () => {
	const colima = `${HOME}/.colima/default/docker.sock`;
	const bothInstalled = () =>
		fakeFs({ [DEFAULT_DOCKER_SOCKET]: '', [colima]: '' }, { [`${HOME}/.colima`]: ['default'] });

	it('uses the explicit override alone, so a typo fails loudly', () => {
		const got = dockerSocketCandidates({
			override: '/custom/docker.sock',
			env: { DOCKER_HOST: `unix://${colima}` },
			home: HOME,
			fs: bothInstalled(),
		});
		expect(got.candidates).toEqual([{ path: '/custom/docker.sock', source: 'flag' }]);
	});

	it('uses DOCKER_HOST when there is no override', () => {
		const got = dockerSocketCandidates({
			env: { DOCKER_HOST: `unix://${colima}` },
			home: HOME,
			fs: bothInstalled(),
		});
		expect(got.candidates).toEqual([{ path: colima, source: 'docker-host' }]);
	});

	it('reports an unsupported transport rather than falling back to a default socket', () => {
		const got = dockerSocketCandidates({
			env: { DOCKER_HOST: 'tcp://localhost:2375' },
			home: HOME,
			fs: bothInstalled(),
		});
		expect(got.candidates).toEqual([]);
		expect(got.unsupported).toEqual({
			scheme: 'tcp',
			source: 'docker-host',
			value: 'tcp://localhost:2375',
		});
	});

	it('prefers the current docker context, keeping well-known paths as a backstop', () => {
		const fs = fakeFs(
			{
				[DEFAULT_DOCKER_SOCKET]: '',
				[colima]: '',
				...contextStore(`${HOME}/.docker`, 'colima', `unix://${colima}`),
			},
			{ [`${HOME}/.colima`]: ['default'] },
		);
		const got = dockerSocketCandidates({ env: {}, home: HOME, fs });
		expect(got.candidates).toEqual([
			{ path: colima, source: 'docker-context', runtime: 'colima' },
			{ path: DEFAULT_DOCKER_SOCKET, source: 'discovered', runtime: 'docker-engine' },
		]);
	});

	it('never lists the context socket twice when discovery finds it too', () => {
		const fs = fakeFs(
			{ [colima]: '', ...contextStore(`${HOME}/.docker`, 'colima', `unix://${colima}`) },
			{ [`${HOME}/.colima`]: ['default'] },
		);
		const paths = dockerSocketCandidates({ env: {}, home: HOME, fs }).candidates.map((c) => c.path);
		expect(paths).toEqual([colima]);
	});

	it('falls back to discovery when no context is configured', () => {
		const got = dockerSocketCandidates({ env: {}, home: HOME, fs: bothInstalled() });
		expect(got.candidates.map((c) => c.source)).toEqual(['discovered', 'discovered']);
	});
});

describe('resolvedDockerSocketPath', () => {
	afterEach(() => setResolvedDockerSocket(null));

	it('returns the socket the preflight settled on', () => {
		setResolvedDockerSocket({
			path: '/tmp/colima.sock',
			source: 'docker-context',
			runtime: 'colima',
		});
		expect(resolvedDockerSocketPath()).toBe('/tmp/colima.sock');
	});

	it('falls back to a discovered socket before the preflight has run', () => {
		setResolvedDockerSocket(null);
		// The fallback is what a DockerClient built outside the server (e.g. `hezo
		// uninstall`) uses, so it must still be a real socket path.
		expect(resolvedDockerSocketPath().endsWith('docker.sock')).toBe(true);
	});

	it('memoizes the fallback so a per-request read is not a filesystem scan', () => {
		setResolvedDockerSocket(null);
		const first = resolvedDockerSocketPath();
		expect(resolvedDockerSocketPath()).toBe(first);
		// Setting (or clearing) the resolved socket is the only thing that can
		// change the answer, and it invalidates the memo.
		setResolvedDockerSocket({ path: '/tmp/other.sock', source: 'flag' });
		expect(resolvedDockerSocketPath()).toBe('/tmp/other.sock');
		setResolvedDockerSocket(null);
		expect(resolvedDockerSocketPath()).toBe(first);
	});
});

describe('describeDockerSocket', () => {
	it('names the runtime and how the socket was found', () => {
		const line = describeDockerSocket(
			{ path: `${HOME}/.colima/default/docker.sock`, source: 'docker-context', runtime: 'colima' },
			HOME,
		);
		expect(line).toContain('~/.colima/default/docker.sock');
		expect(line).toContain('Colima');
		expect(line).toContain('via docker context');
	});

	it('omits the runtime when it is unknown', () => {
		const line = describeDockerSocket({ path: '/custom/docker.sock', source: 'flag' }, HOME);
		expect(line).toContain('/custom/docker.sock');
		expect(line).toContain('via --docker-socket');
	});
});

describe('tildePath', () => {
	it('collapses the home prefix and leaves other paths alone', () => {
		expect(tildePath(`${HOME}/.colima/docker.sock`, HOME)).toBe('~/.colima/docker.sock');
		expect(tildePath('/var/run/docker.sock', HOME)).toBe('/var/run/docker.sock');
		// A path that merely starts with the same characters is not inside home.
		expect(tildePath('/home/tester-other/x.sock', HOME)).toBe('/home/tester-other/x.sock');
	});
});

import { describe, expect, it } from 'vitest';
import { BRIDGE_RUNNER_BINARY, buildBridgeRunnerArgv } from '../../services/ssh-agent/relay';

describe('ssh-agent relay command builder', () => {
	const validArgs = {
		socketPath: '/run/hezo/run-123.sock',
		socketUser: 'node',
		tokenHex: 'a'.repeat(32),
		hostName: 'host.docker.internal',
		hostPort: 12345,
	};

	it('produces the expected argv layout', () => {
		const argv = buildBridgeRunnerArgv(validArgs);
		expect(argv).toEqual([
			BRIDGE_RUNNER_BINARY,
			'/run/hezo/run-123.sock',
			'node',
			'a'.repeat(32),
			'host.docker.internal:12345',
			'--',
		]);
	});

	it('rejects a token that is not 32 lowercase hex chars', () => {
		expect(() => buildBridgeRunnerArgv({ ...validArgs, tokenHex: 'too-short' })).toThrow(
			/token hex/,
		);
		expect(() => buildBridgeRunnerArgv({ ...validArgs, tokenHex: 'A'.repeat(32) })).toThrow(
			/token hex/,
		);
		expect(() => buildBridgeRunnerArgv({ ...validArgs, tokenHex: 'g'.repeat(32) })).toThrow(
			/token hex/,
		);
	});

	it('rejects relative or shell-special socket paths', () => {
		expect(() => buildBridgeRunnerArgv({ ...validArgs, socketPath: 'relative/path' })).toThrow(
			/socket path/,
		);
		expect(() =>
			buildBridgeRunnerArgv({ ...validArgs, socketPath: '/run/hezo/x;rm -rf /' }),
		).toThrow(/socket path/);
	});

	it('rejects host names that contain shell or comma characters', () => {
		expect(() => buildBridgeRunnerArgv({ ...validArgs, hostName: 'host,attacker' })).toThrow(
			/host name/,
		);
		expect(() => buildBridgeRunnerArgv({ ...validArgs, hostName: 'host && evil' })).toThrow(
			/host name/,
		);
	});

	it('rejects ports outside the unprivileged range', () => {
		expect(() => buildBridgeRunnerArgv({ ...validArgs, hostPort: 0 })).toThrow(/host port/);
		expect(() => buildBridgeRunnerArgv({ ...validArgs, hostPort: 70_000 })).toThrow(/host port/);
		expect(() => buildBridgeRunnerArgv({ ...validArgs, hostPort: 1.5 })).toThrow(/host port/);
	});
});

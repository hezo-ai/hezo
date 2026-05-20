import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { buildImageViaCli } from '../../services/image-builder';

class FakeStream extends EventEmitter {
	setEncoding(_enc: string): void {}
}

function makeChildProcess(exitCode = 0): EventEmitter & {
	stdout: FakeStream;
	stderr: FakeStream;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: FakeStream;
		stderr: FakeStream;
	};
	child.stdout = new FakeStream();
	child.stderr = new FakeStream();
	queueMicrotask(() => {
		child.stdout.emit('end');
		child.stderr.emit('end');
		child.emit('close', exitCode);
	});
	return child;
}

describe('buildImageViaCli', () => {
	afterEach(() => spawnMock.mockReset());

	it('passes --label flags for each label entry', async () => {
		spawnMock.mockReturnValue(makeChildProcess(0));

		await buildImageViaCli('hezo/agent-base:latest', '/ctx', '/ctx/Dockerfile', {
			labels: { 'hezo.bundle.sha': 'abc', other: 'x' },
		});

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).toEqual([
			'build',
			'-t',
			'hezo/agent-base:latest',
			'-f',
			'/ctx/Dockerfile',
			'--label',
			'hezo.bundle.sha=abc',
			'--label',
			'other=x',
			'/ctx',
		]);
	});

	it('omits --label when no labels are supplied', async () => {
		spawnMock.mockReturnValue(makeChildProcess(0));

		await buildImageViaCli('hezo/agent-base:latest', '/ctx', '/ctx/Dockerfile');

		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).not.toContain('--label');
		expect(args[args.length - 1]).toBe('/ctx');
	});

	it('still accepts the legacy onLine positional argument', async () => {
		spawnMock.mockReturnValue(makeChildProcess(0));
		const onLine = vi.fn();

		await buildImageViaCli('hezo/agent-base:latest', '/ctx', '/ctx/Dockerfile', onLine);

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).not.toContain('--label');
	});

	it('rejects when docker build exits non-zero', async () => {
		spawnMock.mockReturnValue(makeChildProcess(1));

		await expect(
			buildImageViaCli('hezo/agent-base:latest', '/ctx', '/ctx/Dockerfile'),
		).rejects.toThrow('docker build exited with code 1');
	});
});

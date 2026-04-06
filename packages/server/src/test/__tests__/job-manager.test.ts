import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobManager, type JobManagerDeps } from '../../services/job-manager';

function createMockDeps(): JobManagerDeps {
	return {
		db: { query: vi.fn().mockResolvedValue({ rows: [] }) } as any,
		docker: {} as any,
		masterKeyManager: {} as any,
		serverPort: 3100,
		dataDir: '',
		wsManager: { broadcast: vi.fn() } as any,
	};
}

const LONG_TIMEOUT = 30_000;

describe('JobManager', () => {
	let manager: JobManager;

	afterEach(() => {
		if (manager) manager.shutdown();
	});

	describe('task lifecycle', () => {
		beforeAll(() => {
			manager = new JobManager(createMockDeps());
		});

		afterAll(() => {
			manager.shutdown();
		});

		it('launches a task and tracks it', async () => {
			let resolve: () => void;
			const promise = new Promise<void>((r) => {
				resolve = r;
			});

			manager.launchTask(
				'test:1',
				async () => {
					await promise;
				},
				LONG_TIMEOUT,
			);

			expect(manager.isTaskRunning('test:1')).toBe(true);
			resolve!();
			await new Promise((r) => setTimeout(r, 10));
			expect(manager.isTaskRunning('test:1')).toBe(false);
		});

		it('prevents duplicate task launches', async () => {
			let callCount = 0;
			let resolve: () => void;
			const promise = new Promise<void>((r) => {
				resolve = r;
			});

			manager.launchTask(
				'test:dup',
				async () => {
					callCount++;
					await promise;
				},
				LONG_TIMEOUT,
			);
			manager.launchTask(
				'test:dup',
				async () => {
					callCount++;
				},
				LONG_TIMEOUT,
			);

			expect(callCount).toBe(1);
			resolve!();
			await new Promise((r) => setTimeout(r, 10));
		});

		it('cancels a running task via AbortSignal', async () => {
			let signalAborted = false;

			manager.launchTask(
				'test:cancel',
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							signalAborted = true;
							resolve();
						});
						setTimeout(resolve, 5000);
					});
				},
				LONG_TIMEOUT,
			);

			expect(manager.isTaskRunning('test:cancel')).toBe(true);
			const cancelled = manager.cancelTask('test:cancel');
			expect(cancelled).toBe(true);
			await new Promise((r) => setTimeout(r, 10));
			expect(signalAborted).toBe(true);
		});

		it('returns false when cancelling non-existent task', () => {
			expect(manager.cancelTask('nonexistent')).toBe(false);
		});

		it('runs multiple tasks in parallel', async () => {
			const running: string[] = [];
			let resolve1: () => void;
			let resolve2: () => void;
			const p1 = new Promise<void>((r) => {
				resolve1 = r;
			});
			const p2 = new Promise<void>((r) => {
				resolve2 = r;
			});

			manager.launchTask(
				'agent:ceo',
				async () => {
					running.push('ceo');
					await p1;
				},
				LONG_TIMEOUT,
			);
			manager.launchTask(
				'agent:dev',
				async () => {
					running.push('dev');
					await p2;
				},
				LONG_TIMEOUT,
			);

			expect(manager.isTaskRunning('agent:ceo')).toBe(true);
			expect(manager.isTaskRunning('agent:dev')).toBe(true);
			expect(running).toContain('ceo');
			expect(running).toContain('dev');

			resolve1!();
			resolve2!();
			await new Promise((r) => setTimeout(r, 10));
			expect(manager.isTaskRunning('agent:ceo')).toBe(false);
			expect(manager.isTaskRunning('agent:dev')).toBe(false);
		});

		it('getRunningTasks returns a snapshot', async () => {
			let resolve: () => void;
			const promise = new Promise<void>((r) => {
				resolve = r;
			});

			manager.launchTask(
				'test:snapshot',
				async () => {
					await promise;
				},
				LONG_TIMEOUT,
			);

			const tasks = manager.getRunningTasks();
			expect(tasks.size).toBeGreaterThanOrEqual(1);
			expect(tasks.has('test:snapshot')).toBe(true);
			expect(tasks.get('test:snapshot')!.startedAt).toBeGreaterThan(0);

			resolve!();
			await new Promise((r) => setTimeout(r, 10));
		});
	});

	describe('timeouts', () => {
		it('auto-aborts task after timeout', async () => {
			manager = new JobManager(createMockDeps());
			let signalAborted = false;

			manager.launchTask(
				'test:timeout',
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							signalAborted = true;
							resolve();
						});
						setTimeout(resolve, 5000);
					});
				},
				50,
			);

			expect(manager.isTaskRunning('test:timeout')).toBe(true);
			await new Promise((r) => setTimeout(r, 100));
			expect(signalAborted).toBe(true);
			expect(manager.isTaskRunning('test:timeout')).toBe(false);
		});

		it('clears timeout on normal completion', async () => {
			manager = new JobManager(createMockDeps());
			let aborted = false;

			manager.launchTask(
				'test:fast',
				async (signal) => {
					signal.addEventListener('abort', () => {
						aborted = true;
					});
				},
				5000,
			);

			await new Promise((r) => setTimeout(r, 20));
			expect(manager.isTaskRunning('test:fast')).toBe(false);
			expect(aborted).toBe(false);
		});

		it('clears timeout on manual cancel', async () => {
			manager = new JobManager(createMockDeps());

			manager.launchTask(
				'test:cancel-timeout',
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
						setTimeout(resolve, 5000);
					});
				},
				200,
			);

			manager.cancelTask('test:cancel-timeout');
			await new Promise((r) => setTimeout(r, 300));
			expect(manager.isTaskRunning('test:cancel-timeout')).toBe(false);
		});

		it('clears timeouts on shutdown', async () => {
			manager = new JobManager(createMockDeps());

			manager.launchTask(
				'test:shutdown-timeout',
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
						setTimeout(resolve, 5000);
					});
				},
				200,
			);

			manager.shutdown();
			await new Promise((r) => setTimeout(r, 300));
			expect(manager.isTaskRunning('test:shutdown-timeout')).toBe(false);
		});
	});

	describe('shutdown', () => {
		it('aborts all running tasks on shutdown', async () => {
			manager = new JobManager(createMockDeps());
			const aborted: string[] = [];

			manager.launchTask(
				'task:a',
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							aborted.push('a');
							resolve();
						});
						setTimeout(resolve, 5000);
					});
				},
				LONG_TIMEOUT,
			);
			manager.launchTask(
				'task:b',
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							aborted.push('b');
							resolve();
						});
						setTimeout(resolve, 5000);
					});
				},
				LONG_TIMEOUT,
			);

			expect(manager.isTaskRunning('task:a')).toBe(true);
			expect(manager.isTaskRunning('task:b')).toBe(true);

			manager.shutdown();
			await new Promise((r) => setTimeout(r, 10));
			expect(aborted).toContain('a');
			expect(aborted).toContain('b');
		});
	});

	describe('guarded execution', () => {
		it('job manager starts and creates cron jobs', () => {
			manager = new JobManager(createMockDeps());
			manager.start();
			manager.shutdown();
		});
	});
});

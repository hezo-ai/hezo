import { describe, expect, it } from 'vitest';
import type { ContainerProcessInfo } from '../src/services/docker';
import {
	collectCandidateRunIds,
	decideSweepKills,
	SWEEP_MIN_AGE_SECS,
} from '../src/services/process-sweeper';

const SUCCEEDED_RUN = '11111111-2222-3333-4444-555555555555';
const FAILED_RUN = '99999999-8888-7777-6666-555555555555';
const CHAT_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function proc(over: Partial<ContainerProcessInfo>): ContainerProcessInfo {
	return {
		pid: 100,
		runId: null,
		hasHezoSock: false,
		ageSecs: SWEEP_MIN_AGE_SECS + 1_000,
		cmdline: 'sleep 300',
		...over,
	};
}

describe('collectCandidateRunIds', () => {
	it('returns UUID-format run ids only, deduped — safe for a ::uuid[] lookup', () => {
		const ids = collectCandidateRunIds([
			proc({ runId: SUCCEEDED_RUN }),
			proc({ runId: SUCCEEDED_RUN }),
			proc({ runId: 'provision-0123456789abcdef' }),
			proc({ runId: 'gitop-0123456789abcdef' }),
			proc({ runId: 'mcp-install-0123456789abcdef' }),
			proc({ runId: null }),
			proc({ runId: FAILED_RUN }),
		]);
		expect(ids.sort()).toEqual([SUCCEEDED_RUN, FAILED_RUN].sort());
	});
});

describe('decideSweepKills', () => {
	const succeeded = new Set([SUCCEEDED_RUN]);

	it('kills bridge infrastructure regardless of marker or run status', () => {
		const procs = [
			proc({
				pid: 10,
				runId: SUCCEEDED_RUN,
				cmdline:
					'/bin/sh /usr/local/bin/hezo-run-with-bridge /run/hezo/x.sock node tok h:1 -- git fetch',
			}),
			proc({ pid: 11, cmdline: '/bin/sh /usr/local/bin/hezo-ssh-bridge tok host 123' }),
			proc({
				pid: 12,
				cmdline:
					'socat UNIX-LISTEN:/run/hezo/x.sock,fork EXEC:/usr/local/bin/hezo-ssh-bridge tok h 1',
			}),
		];
		expect(decideSweepKills(procs, succeeded)).toEqual([10, 11, 12]);
	});

	it("preserves a succeeded run's background process (the dev-server case)", () => {
		const procs = [proc({ pid: 20, runId: SUCCEEDED_RUN, cmdline: 'node dev-server.js' })];
		expect(decideSweepKills(procs, succeeded)).toEqual([]);
	});

	it('kills marker-carrying processes of failed/unknown runs, chat sessions, and op tags', () => {
		const procs = [
			proc({ pid: 30, runId: FAILED_RUN }),
			proc({ pid: 31, runId: CHAT_SESSION }),
			proc({ pid: 32, runId: 'provision-0123456789abcdef' }),
			proc({ pid: 33, runId: 'gitop-0123456789abcdef' }),
			proc({ pid: 34, runId: 'mcp-install-0123456789abcdef' }),
		];
		expect(decideSweepKills(procs, succeeded)).toEqual([30, 31, 32, 33, 34]);
	});

	it('kills legacy marker-less processes scoped to a /run/hezo bridge socket', () => {
		const procs = [
			proc({
				pid: 40,
				runId: null,
				hasHezoSock: true,
				cmdline: 'ssh git@github.com git-upload-pack',
			}),
		];
		expect(decideSweepKills(procs, succeeded)).toEqual([40]);
	});

	it('spares young processes — ops started after boot while reconcile still runs', () => {
		const procs = [
			proc({ pid: 50, runId: FAILED_RUN, ageSecs: SWEEP_MIN_AGE_SECS - 1 }),
			proc({
				pid: 51,
				hasHezoSock: true,
				ageSecs: 5,
				cmdline: '/bin/sh /usr/local/bin/hezo-ssh-bridge tok host 123',
			}),
		];
		expect(decideSweepKills(procs, succeeded)).toEqual([]);
	});

	it('never kills PID 1', () => {
		const procs = [proc({ pid: 1, runId: FAILED_RUN, hasHezoSock: true })];
		expect(decideSweepKills(procs, succeeded)).toEqual([]);
	});

	it('leaves unrelated marker-less processes alone', () => {
		const procs = [proc({ pid: 60, cmdline: 'nginx: worker process' })];
		expect(decideSweepKills(procs, succeeded)).toEqual([]);
	});
});

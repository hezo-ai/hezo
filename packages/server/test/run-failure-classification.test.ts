import { describe, expect, it } from 'vitest';
import { classifyRuntimeError } from '../src/services/agent-stream-parser';
import {
	classifyRunFailure,
	RunFailureClass,
	transientRunFailureNames,
} from '../src/services/run-failure-classification';
import { ContainerUnreachableError, ExecStreamLostError } from '../src/services/sandbox/errors';
import { TunnelPortsExhaustedError } from '../src/services/sandbox/tunnel/ports';

describe('classifyRunFailure', () => {
	it('treats a lost output stream as transient', () => {
		expect(classifyRunFailure(new ExecStreamLostError('docker'))).toBe(RunFailureClass.Transient);
	});

	it('treats exhausted tunnel ports as transient', () => {
		expect(classifyRunFailure(new TunnelPortsExhaustedError('c1'))).toBe(RunFailureClass.Transient);
	});

	it('treats an unreachable container as transient', () => {
		// The container was stopped or removed out from under the run - a
		// provider's idle timer, a reclaim, an operator. The next attempt gets a
		// container of its own and finds nothing wrong.
		expect(classifyRunFailure(new ContainerUnreachableError('sandbox x no longer exists'))).toBe(
			RunFailureClass.Transient,
		);
	});

	it('treats an MCP injection fault as permanent', () => {
		// The production failure: a config error reproduces identically on every
		// attempt, so retrying it burns a container per lap and never converges.
		expect(
			classifyRunFailure(
				new Error('adapter declared env-var bearer storage but inlined a bearer token in /x'),
			),
		).toBe(RunFailureClass.Permanent);
	});

	it('treats a provider quota or cap failure as permanent, by default rather than by name', () => {
		// Constructed by name so this test does not import a provider module above
		// the seam - which is also the point being made.
		for (const name of [
			'DaytonaQuotaExceededError',
			'DaytonaMemoryCapExceededError',
			'SandboxImageNotPullableError',
		]) {
			expect(classifyRunFailure(Object.assign(new Error('x'), { name }))).toBe(
				RunFailureClass.Permanent,
			);
		}
	});

	it('treats anything that is not an Error as permanent', () => {
		for (const thrown of [undefined, null, 'a string', 42, { name: 'ExecStreamLostError' }]) {
			expect(classifyRunFailure(thrown)).toBe(RunFailureClass.Permanent);
		}
	});

	it('shares one vocabulary with the parsed path', () => {
		// Two entry points, one answer type: `classifyRunFailure` for a thrown
		// failure, `classifyRuntimeError` for one a runtime reported on its stream.
		// If either stops returning a `RunFailureClass`, the exec path and the parsed
		// path have drifted on what a retry is for, and this is what says so.
		expect(classifyRuntimeError('Selected model is at capacity')?.failure).toBe(
			RunFailureClass.Transient,
		);
		expect(classifyRuntimeError('invalid api key')?.failure).toBe(RunFailureClass.Permanent);
		expect(classifyRunFailure(new ExecStreamLostError('docker'))).toBe(RunFailureClass.Transient);
	});

	it('names no backend, so nothing above the container seam branches on a provider', () => {
		for (const name of transientRunFailureNames()) {
			expect(name).not.toMatch(/Daytona|Docker|Sandbox[A-Z]/);
		}
	});
});

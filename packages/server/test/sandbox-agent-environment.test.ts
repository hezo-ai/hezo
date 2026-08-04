import { SANDBOX_BACKENDS, SandboxBackend } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildContainerEnvironmentBlock,
	SANDBOX_AGENT_ENVIRONMENTS,
} from '../src/services/sandbox/agent-environment';

describe('what an agent is told about its container', () => {
	// The table is the enforcement behind the AGENTS.md rule: a new container
	// service cannot ship with agents silently inheriting another provider's
	// network assumptions. `Record<SandboxBackend, …>` makes that a compile error;
	// this catches an entry added but left empty.
	it('every backend states where it runs and what its egress carries', () => {
		expect(Object.keys(SANDBOX_AGENT_ENVIRONMENTS).sort()).toEqual([...SANDBOX_BACKENDS].sort());
		for (const backend of SANDBOX_BACKENDS) {
			const env = SANDBOX_AGENT_ENVIRONMENTS[backend];
			expect(env.label.length).toBeGreaterThan(0);
			expect(env.location.length).toBeGreaterThan(0);
			expect(env.egress.length).toBeGreaterThan(0);
			for (const line of env.egress) expect(line.trim().length).toBeGreaterThan(0);
		}
	});

	it('names the service and its constraints in the rendered block', () => {
		const block = buildContainerEnvironmentBlock(SandboxBackend.Daytona);
		expect(block).toContain('Daytona');
		expect(block).toContain('a third-party service');
		// The specific thing an agent gets wrong without being told: it reads the
		// reset as the far end refusing its key and retries.
		expect(block).toContain('ssh');
		expect(block).toContain('kex_exchange_identification');
	});

	it('describes local Docker as this machine, not a third party', () => {
		const block = buildContainerEnvironmentBlock(SandboxBackend.Docker);
		expect(block).toContain('this machine');
		expect(block).not.toContain('a third-party service');
	});

	it('says nothing at all for a backend this build does not know', () => {
		// A downgrade or a stale bundle can report a backend the enum has no entry
		// for. Describing it with another provider's constraints would be worse
		// than describing it with none.
		expect(buildContainerEnvironmentBlock('modal' as SandboxBackend)).toBe('');
	});
});

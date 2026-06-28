import { describe, expect, it } from 'vitest';
import { Registry, type RegistryEntry } from '../src/services/ssh-agent/registry';

function entry(runId: string, socketHostPath: string): RegistryEntry {
	return {
		identity: { runId, teamId: 't', agentId: 'a', label: `${runId}/T-1` },
		socketHostPath,
		resolveKeys: async () => [],
	};
}

describe('ssh-agent Registry', () => {
	it('sets and gets entries by runId', () => {
		const reg = new Registry();
		const e = entry('run1', '/sock/1');
		reg.set('run1', e);
		expect(reg.get('run1')).toBe(e);
		expect(reg.get('missing')).toBeUndefined();
	});

	it('finds an entry by its socket host path', () => {
		const reg = new Registry();
		reg.set('run1', entry('run1', '/sock/1'));
		reg.set('run2', entry('run2', '/sock/2'));
		expect(reg.getBySocketPath('/sock/2')?.identity.runId).toBe('run2');
		expect(reg.getBySocketPath('/sock/none')).toBeUndefined();
	});

	it('deletes entries and reports whether one was present', () => {
		const reg = new Registry();
		reg.set('run1', entry('run1', '/sock/1'));
		expect(reg.delete('run1')).toBe(true);
		expect(reg.delete('run1')).toBe(false);
		expect(reg.get('run1')).toBeUndefined();
	});

	it('lists all current entries', () => {
		const reg = new Registry();
		reg.set('run1', entry('run1', '/sock/1'));
		reg.set('run2', entry('run2', '/sock/2'));
		expect(
			reg
				.all()
				.map((e) => e.identity.runId)
				.sort(),
		).toEqual(['run1', 'run2']);
	});
});

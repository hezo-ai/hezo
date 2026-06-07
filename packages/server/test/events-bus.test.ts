import { describe, expect, it } from 'vitest';
import { mapEventToAudit } from '../src/events/audit-observer';
import { DomainEventBus } from '../src/events/bus';
import type { DomainEvent } from '../src/events/types';

describe('DomainEventBus', () => {
	it('fans out an event to every subscriber', () => {
		const bus = new DomainEventBus();
		const seen: string[] = [];
		bus.subscribe((e) => seen.push(`a:${e.type}`));
		bus.subscribe((e) => seen.push(`b:${e.type}`));

		const event: DomainEvent = {
			type: 'project.created',
			teamId: 't1',
			projectId: 'p1',
			actorType: 'admin',
			actorMemberId: null,
			name: 'Demo',
			slug: 'demo',
		};
		bus.emit(event);

		expect(seen).toEqual(['a:project.created', 'b:project.created']);
	});

	it('a throwing subscriber does not break other subscribers', () => {
		const bus = new DomainEventBus();
		const seen: string[] = [];
		bus.subscribe(() => {
			throw new Error('observer boom');
		});
		bus.subscribe((e) => seen.push(e.type));

		expect(() =>
			bus.emit({
				type: 'task.created',
				teamId: 't1',
				projectId: 'p1',
				actorType: 'admin',
				actorMemberId: null,
				taskId: 'task1',
				identifier: 'ENG-1',
			}),
		).not.toThrow();
		expect(seen).toEqual(['task.created']);
	});
});

describe('mapEventToAudit', () => {
	it('maps an agent run completion to an agent_run / run_completed row with typed status', () => {
		const input = mapEventToAudit({
			type: 'agent_run.completed',
			teamId: 't1',
			projectId: 'p1',
			runId: 'run1',
			taskId: 'task1',
			agentMemberId: 'agent1',
			status: 'succeeded',
			exitCode: 0,
			error: null,
		});
		expect(input).not.toBeNull();
		expect(input?.entityType).toBe('agent_run');
		expect(input?.action).toBe('run_completed');
		expect(input?.actorType).toBe('agent');
		expect(input?.actorMemberId).toBe('agent1');
		expect(input?.entityId).toBe('run1');
		expect(input?.details?.status).toBe('succeeded');
	});

	it('attributes a system-prompt document edit to the agent entity', () => {
		const input = mapEventToAudit({
			type: 'document.updated',
			teamId: 't1',
			projectId: null,
			actorType: 'admin',
			actorMemberId: null,
			documentId: 'doc1',
			documentType: 'agent_system_prompt',
			slug: 'system-prompt',
			title: '',
			agentMemberId: 'agent1',
		});
		expect(input?.entityType).toBe('agent');
		expect(input?.entityId).toBe('agent1');
		expect(input?.details?.field).toBe('system_prompt');
	});

	it('maps a credential request to a requested action with no entity id', () => {
		const input = mapEventToAudit({
			type: 'credential.requested',
			teamId: 't1',
			projectId: null,
			actorType: 'agent',
			actorMemberId: 'agent1',
			taskId: 'task1',
			name: 'GITHUB_TOKEN',
		});
		expect(input?.entityType).toBe('secret');
		expect(input?.action).toBe('requested');
		expect(input?.entityId).toBeNull();
	});
});

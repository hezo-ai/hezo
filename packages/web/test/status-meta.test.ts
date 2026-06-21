import { AgentRuntimeStatus, ApprovalType, TaskStatus } from '@hezo/shared';
import { describe, expect, test } from 'vitest';
import {
	agentRuntimeStatusMeta,
	approvalTypeColor,
	taskStatusColor,
	taskStatusMeta,
} from '../src/lib/status-meta';

/**
 * B3 refactor: the per-component status color/label maps are consolidated into
 * src/lib/status-meta. These pin the consolidated mapping (the components'
 * rendering is covered by inbox-approvals / agent-detail / task tests).
 */
describe('status-meta registry', () => {
	test('task status colors match the previous per-status mapping', () => {
		expect(taskStatusColor(TaskStatus.Backlog)).toBe('neutral');
		expect(taskStatusColor(TaskStatus.InProgress)).toBe('warning');
		expect(taskStatusColor(TaskStatus.Review)).toBe('purple');
		expect(taskStatusColor(TaskStatus.Blocked)).toBe('danger');
		expect(taskStatusColor(TaskStatus.Done)).toBe('success');
		expect(taskStatusColor(TaskStatus.Closed)).toBe('neutral');
		expect(taskStatusColor(TaskStatus.Cancelled)).toBe('neutral');
	});

	test('unknown task status falls back to neutral', () => {
		expect(taskStatusColor('bogus')).toBe('neutral');
	});

	test('task status meta carries the shared label', () => {
		expect(taskStatusMeta(TaskStatus.InProgress)).toEqual({
			color: 'warning',
			label: 'In Progress',
		});
	});

	test('agent runtime status meta matches the previous RUNTIME_BADGE', () => {
		expect(agentRuntimeStatusMeta(AgentRuntimeStatus.Active)).toEqual({
			color: 'live',
			label: 'Running',
		});
		expect(agentRuntimeStatusMeta(AgentRuntimeStatus.Idle)).toEqual({
			color: 'neutral',
			label: 'Idle',
		});
		expect(agentRuntimeStatusMeta(AgentRuntimeStatus.OutOfAgentBudget)).toEqual({
			color: 'red',
			label: 'Over agent budget',
		});
		expect(agentRuntimeStatusMeta(AgentRuntimeStatus.OutOfProjectBudget)).toEqual({
			color: 'red',
			label: 'Over project budget',
		});
	});

	test('unknown runtime status falls back to Idle', () => {
		expect(agentRuntimeStatusMeta('bogus')).toEqual({ color: 'neutral', label: 'Idle' });
	});

	test('approval type colors match the previous typeColors (project_creation now explicit)', () => {
		expect(approvalTypeColor(ApprovalType.Strategy)).toBe('purple');
		expect(approvalTypeColor(ApprovalType.DesignatedRepoRequest)).toBe('yellow');
		expect(approvalTypeColor(ApprovalType.Hire)).toBe('green');
		expect(approvalTypeColor(ApprovalType.PlanReview)).toBe('blue');
		expect(approvalTypeColor(ApprovalType.DeployProduction)).toBe('red');
		expect(approvalTypeColor(ApprovalType.SkillProposal)).toBe('blue');
		// Previously fell through to the Badge's neutral default.
		expect(approvalTypeColor(ApprovalType.ProjectCreation)).toBe('neutral');
		expect(approvalTypeColor('bogus')).toBe('neutral');
	});
});

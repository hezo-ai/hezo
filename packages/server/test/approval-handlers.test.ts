import { ApprovalType } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { APPROVAL_HANDLERS } from '../src/services/approval-handlers';

/**
 * Structural guard for the approval side-effect registry (A1 refactor). The
 * end-to-end behaviour parity is covered by approvals.test.ts /
 * approvals-extended.test.ts (which resolve real approvals through
 * resolveApproval → applyApprovalSideEffect); this just pins which types carry
 * a materialised side effect so an accidental drop is caught cheaply.
 */
describe('approval handler registry', () => {
	it('registers a handler for every side-effecting approval type', () => {
		const expected = [ApprovalType.Hire, ApprovalType.Strategy, ApprovalType.SkillProposal];
		for (const type of expected) {
			expect(APPROVAL_HANDLERS[type]).toBeDefined();
			expect(typeof APPROVAL_HANDLERS[type]?.applyApproved).toBe('function');
		}
	});

	it('only the hire approval carries a denied side effect', () => {
		// Hire flips its proposal comment to "denied" and re-wakes the requester on a
		// deny; the other side-effecting types (strategy, skill_proposal) have no
		// denied behaviour, and project creation is no longer an approval at all.
		const withDenied = Object.entries(APPROVAL_HANDLERS)
			.filter(([, handler]) => typeof handler?.applyDenied === 'function')
			.map(([type]) => type);
		expect(withDenied).toEqual([ApprovalType.Hire]);
	});

	it('has no handler for pure status-flip approval types or project creation', () => {
		expect(APPROVAL_HANDLERS[ApprovalType.PlanReview]).toBeUndefined();
		expect(APPROVAL_HANDLERS[ApprovalType.DeployProduction]).toBeUndefined();
		expect(APPROVAL_HANDLERS[ApprovalType.DesignatedRepoRequest]).toBeUndefined();
		expect(APPROVAL_HANDLERS[ApprovalType.ProjectCreation]).toBeUndefined();
	});
});

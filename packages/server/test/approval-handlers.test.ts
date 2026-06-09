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
		const expected = [
			ApprovalType.Hire,
			ApprovalType.Strategy,
			ApprovalType.ProjectCreation,
			ApprovalType.SkillProposal,
		];
		for (const type of expected) {
			expect(APPROVAL_HANDLERS[type]).toBeDefined();
			expect(typeof APPROVAL_HANDLERS[type]?.applyApproved).toBe('function');
		}
	});

	it('only project creation carries a denied side effect', () => {
		const withDenied = Object.entries(APPROVAL_HANDLERS)
			.filter(([, handler]) => typeof handler?.applyDenied === 'function')
			.map(([type]) => type);
		expect(withDenied).toEqual([ApprovalType.ProjectCreation]);
	});

	it('has no handler for pure status-flip approval types', () => {
		expect(APPROVAL_HANDLERS[ApprovalType.SecretAccess]).toBeUndefined();
		expect(APPROVAL_HANDLERS[ApprovalType.PlanReview]).toBeUndefined();
		expect(APPROVAL_HANDLERS[ApprovalType.DeployProduction]).toBeUndefined();
		expect(APPROVAL_HANDLERS[ApprovalType.DesignatedRepoRequest]).toBeUndefined();
	});
});

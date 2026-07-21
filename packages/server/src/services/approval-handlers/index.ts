import { ApprovalType } from '@hezo/shared';
import { goalSuggestionHandler } from './goal-suggestion';
import { hireHandler } from './hire';
import { skillProposalHandler } from './skill-proposal';
import { strategyHandler } from './strategy';
import type { ApprovalHandler } from './types';

/**
 * Per-approval-type side-effect handler table, modelled on `MCP_ADAPTERS`.
 * `Partial` because not every approval type has a side effect — secret access,
 * plan review, deploy, and designated-repo requests are pure status flips with
 * nothing to materialise, so they have no entry and the dispatcher returns `[]`.
 * Adding a side effect for one of those is a one-line addition here.
 *
 * Project creation is deliberately NOT here: a new project is created directly
 * by the CEO's `create_project` MCP tool once the admin approves in the intake
 * conversation, not through a formal approval gate.
 */
export const APPROVAL_HANDLERS: Partial<Record<ApprovalType, ApprovalHandler>> = {
	[ApprovalType.Hire]: hireHandler,
	[ApprovalType.Strategy]: strategyHandler,
	[ApprovalType.SkillProposal]: skillProposalHandler,
	[ApprovalType.GoalSuggestion]: goalSuggestionHandler,
};

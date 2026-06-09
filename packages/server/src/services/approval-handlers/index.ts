import { ApprovalType } from '@hezo/shared';
import { hireHandler } from './hire';
import { projectCreationHandler } from './project-creation';
import { skillProposalHandler } from './skill-proposal';
import { strategyHandler } from './strategy';
import type { ApprovalHandler } from './types';

/**
 * Per-approval-type side-effect handler table, modelled on `MCP_ADAPTERS`.
 * `Partial` because not every approval type has a side effect — secret access,
 * plan review, deploy, and designated-repo requests are pure status flips with
 * nothing to materialise, so they have no entry and the dispatcher returns `[]`.
 * Adding a side effect for one of those is a one-line addition here.
 */
export const APPROVAL_HANDLERS: Partial<Record<ApprovalType, ApprovalHandler>> = {
	[ApprovalType.Hire]: hireHandler,
	[ApprovalType.Strategy]: strategyHandler,
	[ApprovalType.ProjectCreation]: projectCreationHandler,
	[ApprovalType.SkillProposal]: skillProposalHandler,
};

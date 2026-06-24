import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, type AuditActorType, wsRoom } from '@hezo/shared';
import type { DomainEventBus } from '../events/bus';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { terminalStatusParams } from '../lib/sql';
import { logger } from '../logger';
import { enqueueTeamCoherenceReviewTask } from './description-tasks';
import type { WebSocketManager } from './ws';

const log = logger.child('agent-admin');

export interface SetAgentAdminStatusDeps {
	db: PGlite;
	wsManager?: WebSocketManager;
	events?: DomainEventBus;
}

export interface SetAgentAdminStatusParams {
	teamId: string;
	agentId: string;
	status: AgentAdminStatus;
	actorType: AuditActorType;
	actorMemberId: string | null;
	actorApiKeyId?: string | null;
}

export type SetAgentAdminStatusResult =
	| { ok: true; status: AgentAdminStatus }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'already_in_state'; status: AgentAdminStatus };

/**
 * Enable ("reinstate") or disable ("retire") an agent on a team — the single
 * source of truth shared by the REST routes (admin via the web UI) and the
 * `set_agent_status` MCP tool (CEO/Captain). Disabling stops the agent from being
 * scheduled and unassigns it from every open task; both directions enqueue a
 * coherence review, broadcast the change, and emit the audit event. The change is
 * reversible — a disabled agent retains all its data and can be re-enabled.
 *
 * Callers are responsible for authorizing the actor and for any policy guardrails
 * (e.g. refusing to disable a Captain or instance agent); this function only
 * applies the state transition.
 */
export async function setAgentAdminStatus(
	deps: SetAgentAdminStatusDeps,
	params: SetAgentAdminStatusParams,
): Promise<SetAgentAdminStatusResult> {
	const { db, wsManager, events } = deps;
	const { teamId, agentId, status } = params;

	const existing = await db.query<{ admin_status: string }>(
		`SELECT ma.admin_status FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.team_id = $2`,
		[agentId, teamId],
	);
	if (existing.rows.length === 0) return { ok: false, reason: 'not_found' };
	if (existing.rows[0].admin_status === status) {
		return { ok: false, reason: 'already_in_state', status };
	}

	await db.query(`UPDATE member_agents SET admin_status = $1::agent_admin_status WHERE id = $2`, [
		status,
		agentId,
	]);

	// Disabling pulls the agent off its open work so nothing stalls on an agent
	// that will never run; terminal tasks keep their historical assignee.
	if (status === AgentAdminStatus.Disabled) {
		const ts = terminalStatusParams(2, false);
		await db.query(
			`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN (${ts.placeholders})`,
			[agentId, ...ts.values],
		);
	}

	broadcastRowChange(wsManager, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
		id: agentId,
		admin_status: status,
	});

	const reason = status === AgentAdminStatus.Disabled ? 'agent_removed' : 'enabled_changed';
	trackBackground(
		enqueueTeamCoherenceReviewTask(db, teamId, reason).catch((e) =>
			log.error(`Failed to enqueue team coherence review on ${reason}:`, e),
		),
	);

	events?.emit({
		type: status === AgentAdminStatus.Disabled ? 'agent.disabled' : 'agent.enabled',
		teamId,
		actorType: params.actorType,
		actorMemberId: params.actorMemberId,
		actorApiKeyId: params.actorApiKeyId ?? null,
		agentMemberId: agentId,
	});

	return { ok: true, status };
}

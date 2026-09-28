import {
	AI_PROVIDER_INFO,
	type AiProvider,
	AiProviderStatus,
	DEFAULT_TEAM_ID,
	TaskPriority,
	TaskStatus,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import {
	DEFAULT_MODEL_BACKFILL_META_KEY,
	type DefaultModelBackfill,
} from '../db/migrations/code/082_allowance_pacing';
import { broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import { getSystemMeta, setSystemMeta } from '../lib/system-meta';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { HEZO_VERSION } from '../version';
import { postAdminNotice } from './comment-wakeups';
import { listCredentialModels } from './credential-models';
import type { WebSocketManager } from './ws';

const log = logger.child('credential-model-notices');

/** The system comment kind listing the models an upgrade gave credentials that had none. */
export const DEFAULT_MODEL_BACKFILL_COMMENT_KIND = 'default_model_backfill';

/** The system comment kind listing credentials whose model their provider no longer offers. */
export const CREDENTIAL_MODEL_UNLISTED_COMMENT_KIND = 'credential_model_unlisted';

/** The release whose credential models were last checked against their live lists. */
const MODEL_CHECK_META_KEY = 'credential_model_check_release';

/** One credential a notice names. */
export interface CredentialModelLine {
	label: string;
	provider: string;
	model: string | null;
}

/**
 * Open an unassigned HQ task, so no agent is woken to read it, and post the
 * notice on it for the admin. The claim runs in the same transaction, so a
 * restart cannot post the notice twice. Returns the task, or null when the claim
 * found nothing to post.
 */
async function postOnHqTask(
	db: Db,
	wsManager: WebSocketManager | undefined,
	claim: () => Promise<boolean>,
	task: { title: string; description: string },
	content: { kind: string; text: string } & Record<string, unknown>,
): Promise<void> {
	const hq = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[DEFAULT_TEAM_ID],
	);
	const projectId = hq.rows[0]?.id;
	if (!projectId) {
		log.warn(`No HQ project to post the "${task.title}" notice on`);
		return;
	}
	const row = await withTransaction(db, async () => {
		if (!(await claim())) return null;
		const { number, identifier } = await allocateTaskIdentifier(db, projectId);
		const inserted = await db.query<Record<string, unknown> & { id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, description,
			                    status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, $8::task_priority, '[]'::jsonb)
			 RETURNING *`,
			[
				DEFAULT_TEAM_ID,
				projectId,
				number,
				identifier,
				task.title,
				task.description,
				TaskStatus.Backlog,
				TaskPriority.Medium,
			],
		);
		const created = inserted.rows[0];
		await postAdminNotice({ db, teamId: DEFAULT_TEAM_ID, taskId: created.id, content, wsManager });
		return created;
	});
	if (row && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(DEFAULT_TEAM_ID), 'tasks', 'INSERT', row);
	}
}

/** One credential as a line of plain text. */
function lineText(line: CredentialModelLine): string {
	return line.model
		? `${line.label} (${line.provider}): ${line.model}`
		: `${line.label} (${line.provider}): needs a model chosen`;
}

/**
 * Tell the admin, once, which credentials migration 082 gave a model and which
 * still need one chosen. The record is removed in the same transaction as the
 * post; an instance where every credential already had a model has no record.
 */
export async function postDefaultModelBackfillNotice(
	db: Db,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const raw = await getSystemMeta(db, DEFAULT_MODEL_BACKFILL_META_KEY);
	if (!raw) return;
	const lines = JSON.parse(raw) as DefaultModelBackfill[];
	await postOnHqTask(
		db,
		wsManager,
		async () => {
			const claimed = await db.query(`DELETE FROM system_meta WHERE key = $1 RETURNING key`, [
				DEFAULT_MODEL_BACKFILL_META_KEY,
			]);
			return claimed.rows.length > 0;
		},
		{
			title: 'Every AI provider now has a default model',
			description:
				'Every run now names its model, so a CLI upgrade can no longer change the model your agents run on. This upgrade gave a model to each AI provider that had none. Check each one in Settings > AI Providers, then close this task.',
		},
		{
			kind: DEFAULT_MODEL_BACKFILL_COMMENT_KIND,
			credentials: lines,
			text: `This upgrade gave a default model to each AI provider that had none:\n${lines.map(lineText).join('\n')}`,
		},
	);
}

/**
 * Check, once per release, that every credential's model is still one its
 * provider offers, and tell the admin about any that is not.
 *
 * A CLI upgrade ships in a release and can drop a model from what a subscription
 * may run. A run on such a model fails at the provider, loudly; this says so
 * before the first run does. The model is left as it is: it is the admin's
 * choice, and the picker marks it as no longer listed. A credential whose list
 * cannot be read now is retried at the next start rather than passed over.
 */
export async function checkCredentialModelsForRelease(deps: {
	db: Db;
	masterKeyManager: MasterKeyManager;
	wsManager?: WebSocketManager;
}): Promise<void> {
	const { db } = deps;
	if ((await getSystemMeta(db, MODEL_CHECK_META_KEY)) === HEZO_VERSION) return;

	const configs = await db.query<{ id: string; label: string; provider: string; model: string }>(
		`SELECT id, label, provider::text AS provider, default_model AS model
		   FROM ai_provider_configs
		  WHERE status = $1 AND default_model IS NOT NULL
		  ORDER BY created_at, id`,
		[AiProviderStatus.Verified],
	);
	const unlisted: CredentialModelLine[] = [];
	let unread = 0;
	for (const config of configs.rows) {
		// A local runner lists what its operator pulled, which no release changes,
		// and its address is often one only the agent containers can reach.
		if (AI_PROVIDER_INFO[config.provider as AiProvider]?.local) continue;
		const listed = await listCredentialModels(deps, config.id);
		if (!listed?.ok) {
			unread += 1;
			continue;
		}
		if (!listed.models.some((m) => m.id === config.model)) {
			unlisted.push({ label: config.label, provider: config.provider, model: config.model });
		}
	}

	if (unread > 0) {
		log.warn(
			`Could not read the model list for ${unread} AI provider(s); they will be checked at the next start`,
		);
		return;
	}
	if (unlisted.length > 0) {
		await postOnHqTask(
			db,
			deps.wsManager,
			async () => true,
			{
				title: 'An AI provider runs a model its provider no longer offers',
				description:
					'After this upgrade, the providers below no longer list the model each one is set to. Runs on it will fail at the provider. Choose another model for each in Settings > AI Providers, then close this task.',
			},
			{
				kind: CREDENTIAL_MODEL_UNLISTED_COMMENT_KIND,
				credentials: unlisted,
				text: `These AI providers are set to a model their provider no longer offers:\n${unlisted.map(lineText).join('\n')}`,
			},
		);
	}
	await setSystemMeta(db, MODEL_CHECK_META_KEY, HEZO_VERSION);
}

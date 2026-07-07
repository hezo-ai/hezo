import type { CommentAttachment } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { signAssetUrl } from './asset-urls';

/**
 * Load the file attachments for a set of realtime-chat messages, keyed by
 * message id, each with a freshly-signed read URL. Mirrors the task-comment
 * `loadAttachmentsForComments` helper. Returns an empty map for `[]`.
 */
export async function loadChatMessageAttachments(
	db: Db,
	messageIds: string[],
	masterKeyManager: MasterKeyManager,
): Promise<Map<string, CommentAttachment[]>> {
	const out = new Map<string, CommentAttachment[]>();
	if (messageIds.length === 0) return out;
	const rows = await db.query<{
		chat_message_id: string;
		id: string;
		content_type: string;
		byte_size: number;
		original_filename: string;
	}>(
		`SELECT ca.chat_message_id, a.id, a.content_type, a.byte_size, a.original_filename
		 FROM chat_message_attachments ca
		 JOIN assets a ON a.id = ca.asset_id
		 WHERE ca.chat_message_id = ANY($1::uuid[])
		 ORDER BY ca.created_at ASC`,
		[messageIds],
	);
	for (const row of rows.rows) {
		const url = await signAssetUrl(row.id, masterKeyManager);
		const list = out.get(row.chat_message_id) ?? [];
		list.push({
			id: row.id,
			content_type: row.content_type,
			byte_size: row.byte_size,
			original_filename: row.original_filename,
			url,
		});
		out.set(row.chat_message_id, list);
	}
	return out;
}

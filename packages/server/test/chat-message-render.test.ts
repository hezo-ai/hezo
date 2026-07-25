import { ChatChannel, HQ_PROJECT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { INSTANCE_BASE_URL_KEY, setSystemMeta } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { renderChatMessageForChannel } from '../src/services/chat-message-render';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;

let projectSlug: string;
const BASE = 'https://hezo.example.com';
// A comment's public_id is its creation-timestamp slug (YYYYMMDDHHMMSS).
const COMMENT_ID = '20261009112345';

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Render Co', template_id: typeId });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Render Project' });
	const project = (await projectRes.json()).data;
	projectSlug = project.slug;

	await db.query(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, 901, 'RD-901', 'Render ticket')`,
		[teamId, project.id],
	);
	await db.query(
		`INSERT INTO documents (team_id, project_id, type, slug, title, content)
		 VALUES ($1, $2, 'project_doc'::document_type, 'spec.md', 'spec.md', 'spec body')`,
		[teamId, project.id],
	);
	await db.query(
		`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
		 VALUES ($1, $2, 'image/png', 4, 'deadbeef', 'mock.png')`,
		[teamId, project.id],
	);
	await db.query(
		`INSERT INTO skills (slug, name, content) VALUES ('playbook.md', 'Playbook', 'kb')`,
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('renderChatMessageForChannel', () => {
	const message = 'Check RD-901 and spec.md before review.';

	it('returns web content unchanged — the client renders links itself', async () => {
		expect(await renderChatMessageForChannel(db, message, ChatChannel.Web)).toBe(message);
	});

	it('returns whatsapp content unchanged — plain-text policy', async () => {
		await setSystemMeta(db, INSTANCE_BASE_URL_KEY, BASE);
		expect(await renderChatMessageForChannel(db, message, ChatChannel.WhatsApp)).toBe(message);
	});

	it('returns telegram content unchanged while no base URL is configured', async () => {
		await db.query('DELETE FROM system_meta WHERE key = $1', [INSTANCE_BASE_URL_KEY]);
		expect(await renderChatMessageForChannel(db, message, ChatChannel.Telegram)).toBe(message);
	});

	describe('telegram with a base URL', () => {
		beforeAll(async () => {
			await setSystemMeta(db, INSTANCE_BASE_URL_KEY, BASE);
		});

		it('links a unique task reference', async () => {
			expect(await renderChatMessageForChannel(db, 'See RD-901 now', ChatChannel.Telegram)).toBe(
				`See [RD-901](${BASE}/projects/${projectSlug}/tasks/rd-901) now`,
			);
		});

		it('links a comment reference via the task it belongs to', async () => {
			expect(
				await renderChatMessageForChannel(
					db,
					`Answered in RD-901#comment-${COMMENT_ID} today`,
					ChatChannel.Telegram,
				),
			).toBe(
				`Answered in [RD-901#comment-${COMMENT_ID}](${BASE}/projects/${projectSlug}/tasks/rd-901#comment-${COMMENT_ID}) today`,
			);
		});

		it('links project docs, KB docs, and assets', async () => {
			expect(
				await renderChatMessageForChannel(
					db,
					'Read spec.md and playbook.md plus assets/mock.png today',
					ChatChannel.Telegram,
				),
			).toBe(
				`Read [spec.md](${BASE}/projects/${projectSlug}/documents?file=spec.md) ` +
					`and [playbook.md](${BASE}/settings/skills?slug=playbook.md) ` +
					`plus [assets/mock.png](${BASE}/projects/${projectSlug}/assets/view?file=mock.png) today`,
			);
		});

		it('links agents to their home project and @admin to the global inbox', async () => {
			expect(
				await renderChatMessageForChannel(db, 'Ask @@ceo or @admin first', ChatChannel.Telegram),
			).toBe(
				`Ask [ceo](${BASE}/projects/${HQ_PROJECT_SLUG}/agents/ceo) ` +
					`or [@admin](${BASE}${'/home/inbox'}) first`,
			);
		});

		it('strips the @@ prefix from an unresolved passive mention, keeping the bare slug', async () => {
			// A passive @@slug that resolves to no agent (unknown, or ambiguous across
			// teams) still sheds its internal `@@` syntax; an unresolved active @slug
			// keeps its (readable) prefix as plain text.
			expect(
				await renderChatMessageForChannel(
					db,
					'Handed to @@nobody, cc @ghost',
					ChatChannel.Telegram,
				),
			).toBe('Handed to nobody, cc @ghost');
		});

		it('keeps unknown references and code spans bare in a mixed message', async () => {
			const mixed = 'RD-901 is real but ZZ-99 is not, and `RD-901` stays code:\n```\nRD-901\n```';
			expect(await renderChatMessageForChannel(db, mixed, ChatChannel.Telegram)).toBe(
				`[RD-901](${BASE}/projects/${projectSlug}/tasks/rd-901) is real but ZZ-99 is not, ` +
					'and `RD-901` stays code:\n```\nRD-901\n```',
			);
		});
	});
});

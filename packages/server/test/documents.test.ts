import { DocumentType } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	getDocument,
	listDocuments,
	listRevisions,
	restoreRevision,
	setDocumentArchived,
	upsertDocument,
} from '../src/services/documents';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const co = await db.query<{ id: string }>(
		"INSERT INTO teams (name, slug) VALUES ('Doc Service Co', 'doc-service-co') RETURNING id",
	);
	teamId = co.rows[0].id;

	const proj = await db.query<{ id: string }>(
		"INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Doc Service Project', 'ds-proj', 'DS') RETURNING id",
		[teamId],
	);
	projectId = proj.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('documents service', () => {
	it('upserts a project_doc and creates no revision on first insert', async () => {
		const doc = await upsertDocument(db, undefined, {
			scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug: 'svc-test' },
			title: 'Service Test',
			content: 'first',
			authorMemberId: null,
		});
		expect(doc.status).toBe('written');
		expect(doc.row.title).toBe('Service Test');
		expect(doc.row.content).toBe('first');

		const revs = await listRevisions(db, doc.row.id);
		expect(revs.length).toBe(0);
	});

	it('creates a revision when content changes', async () => {
		const initial = await upsertDocument(db, undefined, {
			scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug: 'svc-test' },
			content: 'second',
			changeSummary: 'bumped',
			authorMemberId: null,
		});

		const revs = await listRevisions(db, initial.row.id);
		expect(revs.length).toBe(1);
		expect(revs[0].content).toBe('first');
		expect(revs[0].change_summary).toBe('bumped');
		expect(revs[0].revision_number).toBe(1);
	});

	it('does not create a revision when content is identical', async () => {
		const doc = await getDocument(db, {
			type: DocumentType.ProjectDoc,
			teamId,
			projectId,
			slug: 'svc-test',
		});
		expect(doc).not.toBeNull();
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug: 'svc-test' },
			content: 'second',
			authorMemberId: null,
		});

		const revs = await listRevisions(db, doc!.id);
		expect(revs.length).toBe(1);
	});

	it('restores to a prior revision and snapshots current', async () => {
		const doc = await getDocument(db, {
			type: DocumentType.ProjectDoc,
			teamId,
			projectId,
			slug: 'svc-test',
		});
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug: 'svc-test' },
			content: 'third',
			authorMemberId: null,
		});

		const restored = await restoreRevision(db, undefined, {
			documentId: doc!.id,
			revisionNumber: 1,
			restoredByMemberId: null,
		});
		expect(restored.status).toBe('restored');
		expect(restored.status === 'restored' && restored.row.content).toBe('first');

		const revs = await listRevisions(db, doc!.id);
		expect(revs.length).toBe(3);
		expect(revs[0].change_summary).toBe('Restored content from revision 1');
		expect(revs[0].content).toBe('third');
	});

	it('reports not_found when restoring a missing revision', async () => {
		const doc = await getDocument(db, {
			type: DocumentType.ProjectDoc,
			teamId,
			projectId,
			slug: 'svc-test',
		});
		const result = await restoreRevision(db, undefined, {
			documentId: doc!.id,
			revisionNumber: 999,
			restoredByMemberId: null,
		});
		expect(result.status).toBe('not_found');
	});

	it('scopes project_doc upsert by project_id and treats slug as filename', async () => {
		const doc = await upsertDocument(db, undefined, {
			scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug: 'svc-spec.md' },
			content: 'pd v1',
			authorMemberId: null,
		});
		expect(doc.status).toBe('written');
		expect(doc.row.slug).toBe('svc-spec.md');
		expect(doc.row.project_id).toBe(projectId);

		const list = await listDocuments(db, {
			type: DocumentType.ProjectDoc,
			teamId,
			projectId,
		});
		expect(list.some((d) => d.slug === 'svc-spec.md')).toBe(true);
	});

	// The rule lives inside upsertDocument/restoreRevision rather than at each
	// call site, so these exercise the service directly — bypassing every route
	// pre-check — to prove a new caller inherits the refusal.
	describe('archived docs are read-only', () => {
		const slug = 'svc-archived.md';

		beforeAll(async () => {
			await upsertDocument(db, undefined, {
				scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug },
				content: 'original body',
				authorMemberId: null,
			});
			await setDocumentArchived(
				db,
				undefined,
				{ type: DocumentType.ProjectDoc, teamId, projectId, slug },
				true,
				null,
			);
		});

		it('refuses upsertDocument and leaves content and revisions untouched', async () => {
			const before = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId,
				projectId,
				slug,
			});
			const revsBefore = await listRevisions(db, before!.id);

			const result = await upsertDocument(db, undefined, {
				scope: { type: DocumentType.ProjectDoc, teamId, projectId, slug },
				content: 'resurrected body',
				changeSummary: 'should not land',
				authorMemberId: null,
			});

			expect(result.status).toBe('archived');
			const after = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId,
				projectId,
				slug,
			});
			expect(after!.content).toBe('original body');
			expect(after!.archived_at).not.toBeNull();
			expect((await listRevisions(db, before!.id)).length).toBe(revsBefore.length);
		});

		it('refuses restoreRevision and leaves content untouched', async () => {
			const doc = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId,
				projectId,
				slug,
			});
			const result = await restoreRevision(db, undefined, {
				documentId: doc!.id,
				revisionNumber: 1,
				restoredByMemberId: null,
			});

			expect(result.status).toBe('archived');
			const after = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId,
				projectId,
				slug,
			});
			expect(after!.content).toBe('original body');
		});

		it('is a no-op for scopes that are never archived (agent system prompts)', async () => {
			const agent = await db.query<{ id: string }>(
				`WITH m AS (
				   INSERT INTO members (team_id, display_name, member_type) VALUES ($1, 'Prompt Agent', 'agent') RETURNING id
				 )
				 INSERT INTO member_agents (id, slug, title) SELECT id, 'prompt-agent', 'Prompt Agent' FROM m
				 RETURNING id`,
				[teamId],
			);
			const memberAgentId = agent.rows[0].id;
			for (const content of ['prompt v1', 'prompt v2']) {
				const r = await upsertDocument(db, undefined, {
					scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId },
					content,
					authorMemberId: null,
				});
				expect(r.status).toBe('written');
			}
		});
	});

	it('enforces singleton team_preferences scoping', async () => {
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.TeamPreferences, teamId },
			content: 'prefs v1',
			authorMemberId: null,
		});
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.TeamPreferences, teamId },
			content: 'prefs v2',
			authorMemberId: null,
		});

		const all = await db.query<{ count: string }>(
			"SELECT COUNT(*)::text AS count FROM documents WHERE type = 'team_preferences' AND team_id = $1",
			[teamId],
		);
		expect(Number(all.rows[0].count)).toBe(1);
	});
});

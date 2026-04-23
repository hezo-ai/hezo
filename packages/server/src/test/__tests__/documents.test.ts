import type { PGlite } from '@electric-sql/pglite';
import { DocumentType } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	getDocument,
	listDocuments,
	listRevisions,
	restoreRevision,
	upsertDocument,
} from '../../services/documents';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let companyId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const co = await db.query<{ id: string }>(
		"INSERT INTO companies (name, slug) VALUES ('Doc Service Co', 'doc-service-co') RETURNING id",
	);
	companyId = co.rows[0].id;

	const proj = await db.query<{ id: string }>(
		"INSERT INTO projects (company_id, name, slug, issue_prefix) VALUES ($1, 'Doc Service Project', 'ds-proj', 'DS') RETURNING id",
		[companyId],
	);
	projectId = proj.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('documents service', () => {
	it('upserts a kb_doc and creates no revision on first insert', async () => {
		const doc = await upsertDocument(db, undefined, {
			scope: { type: DocumentType.KbDoc, companyId, slug: 'svc-test' },
			title: 'Service Test',
			content: 'first',
			authorMemberId: null,
		});
		expect(doc.title).toBe('Service Test');
		expect(doc.content).toBe('first');

		const revs = await listRevisions(db, doc.id);
		expect(revs.length).toBe(0);
	});

	it('creates a revision when content changes', async () => {
		const initial = await upsertDocument(db, undefined, {
			scope: { type: DocumentType.KbDoc, companyId, slug: 'svc-test' },
			content: 'second',
			changeSummary: 'bumped',
			authorMemberId: null,
		});

		const revs = await listRevisions(db, initial.id);
		expect(revs.length).toBe(1);
		expect(revs[0].content).toBe('first');
		expect(revs[0].change_summary).toBe('bumped');
		expect(revs[0].revision_number).toBe(1);
	});

	it('does not create a revision when content is identical', async () => {
		const doc = await getDocument(db, {
			type: DocumentType.KbDoc,
			companyId,
			slug: 'svc-test',
		});
		expect(doc).not.toBeNull();
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.KbDoc, companyId, slug: 'svc-test' },
			content: 'second',
			authorMemberId: null,
		});

		const revs = await listRevisions(db, doc!.id);
		expect(revs.length).toBe(1);
	});

	it('restores to a prior revision and snapshots current', async () => {
		const doc = await getDocument(db, {
			type: DocumentType.KbDoc,
			companyId,
			slug: 'svc-test',
		});
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.KbDoc, companyId, slug: 'svc-test' },
			content: 'third',
			authorMemberId: null,
		});

		const restored = await restoreRevision(db, undefined, {
			documentId: doc!.id,
			revisionNumber: 1,
			restoredByMemberId: null,
		});
		expect(restored?.content).toBe('first');

		const revs = await listRevisions(db, doc!.id);
		expect(revs.length).toBe(3);
		expect(revs[0].change_summary).toBe('Restored to revision 1');
		expect(revs[0].content).toBe('third');
	});

	it('returns null when restoring a missing revision', async () => {
		const doc = await getDocument(db, {
			type: DocumentType.KbDoc,
			companyId,
			slug: 'svc-test',
		});
		const result = await restoreRevision(db, undefined, {
			documentId: doc!.id,
			revisionNumber: 999,
			restoredByMemberId: null,
		});
		expect(result).toBeNull();
	});

	it('scopes project_doc upsert by project_id and treats slug as filename', async () => {
		const doc = await upsertDocument(db, undefined, {
			scope: { type: DocumentType.ProjectDoc, companyId, projectId, slug: 'svc-spec.md' },
			content: 'pd v1',
			authorMemberId: null,
		});
		expect(doc.slug).toBe('svc-spec.md');
		expect(doc.project_id).toBe(projectId);

		const list = await listDocuments(db, {
			type: DocumentType.ProjectDoc,
			companyId,
			projectId,
		});
		expect(list.some((d) => d.slug === 'svc-spec.md')).toBe(true);
	});

	it('enforces singleton company_preferences scoping', async () => {
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.CompanyPreferences, companyId },
			content: 'prefs v1',
			authorMemberId: null,
		});
		await upsertDocument(db, undefined, {
			scope: { type: DocumentType.CompanyPreferences, companyId },
			content: 'prefs v2',
			authorMemberId: null,
		});

		const all = await db.query<{ count: string }>(
			"SELECT COUNT(*)::text AS count FROM documents WHERE type = 'company_preferences' AND company_id = $1",
			[companyId],
		);
		expect(Number(all.rows[0].count)).toBe(1);
	});
});

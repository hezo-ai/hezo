import type { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { readSkillFile, readSkillManifest, resolveSkillsPath } from '../lib/docs';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import {
	downloadAndSaveSkill,
	removeSkill,
	SkillDownloadError,
	syncSkill,
	updateSkillMetadata,
} from '../services/skill-downloader';

export const skillsRoutes = new Hono<Env>();

async function getCompanySlug(db: PGlite, companyId: string): Promise<string | null> {
	const result = await db.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [
		companyId,
	]);
	return result.rows[0]?.slug ?? null;
}

function downloadErrorStatus(reason: SkillDownloadError['reason']): 400 | 404 | 422 | 503 {
	switch (reason) {
		case 'invalid_url':
		case 'forbidden_scheme':
			return 400;
		case 'not_found':
			return 404;
		case 'too_large':
			return 422;
		case 'timeout':
		case 'network':
			return 503;
	}
}

skillsRoutes.get('/companies/:companyId/skills', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;

	const companySlug = await getCompanySlug(db, companyId);
	if (!companySlug) return err(c, 'NOT_FOUND', 'Company not found', 404);

	const skillsDir = resolveSkillsPath(dataDir, companySlug);
	const manifest = readSkillManifest(skillsDir);
	return ok(c, manifest.skills);
});

skillsRoutes.get('/companies/:companyId/skills/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const companySlug = await getCompanySlug(db, companyId);
	if (!companySlug) return err(c, 'NOT_FOUND', 'Company not found', 404);

	const skillsDir = resolveSkillsPath(dataDir, companySlug);
	const manifest = readSkillManifest(skillsDir);
	const entry = manifest.skills.find((s) => s.slug === slug);
	if (!entry) return err(c, 'NOT_FOUND', 'Skill not found', 404);

	const content = readSkillFile(skillsDir, slug) ?? '';
	return ok(c, { ...entry, content });
});

skillsRoutes.post('/companies/:companyId/skills', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;

	const body = await c.req.json<{
		name: string;
		source_url: string;
		description?: string;
		slug?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (!body.source_url?.trim()) {
		return err(c, 'INVALID_REQUEST', 'source_url is required', 400);
	}

	const companySlug = await getCompanySlug(db, companyId);
	if (!companySlug) return err(c, 'NOT_FOUND', 'Company not found', 404);

	const slug = body.slug?.trim() || toSlug(body.name);
	if (!slug) {
		return err(c, 'INVALID_REQUEST', 'slug could not be derived from name', 400);
	}

	try {
		const entry = await downloadAndSaveSkill(dataDir, companySlug, {
			name: body.name.trim(),
			slug,
			description: body.description?.trim() ?? '',
			source_url: body.source_url.trim(),
		});
		return ok(c, entry, 201);
	} catch (e) {
		if (e instanceof SkillDownloadError) {
			return err(c, 'SKILL_DOWNLOAD_FAILED', e.message, downloadErrorStatus(e.reason));
		}
		throw e;
	}
});

skillsRoutes.patch('/companies/:companyId/skills/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const companySlug = await getCompanySlug(db, companyId);
	if (!companySlug) return err(c, 'NOT_FOUND', 'Company not found', 404);

	const body = await c.req.json<{ name?: string; description?: string }>();
	const entry = updateSkillMetadata(dataDir, companySlug, slug, {
		name: body.name?.trim(),
		description: body.description?.trim(),
	});
	if (!entry) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return ok(c, entry);
});

skillsRoutes.post('/companies/:companyId/skills/:slug/sync', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const companySlug = await getCompanySlug(db, companyId);
	if (!companySlug) return err(c, 'NOT_FOUND', 'Company not found', 404);

	try {
		const entry = await syncSkill(dataDir, companySlug, slug);
		return ok(c, entry);
	} catch (e) {
		if (e instanceof SkillDownloadError) {
			return err(c, 'SKILL_DOWNLOAD_FAILED', e.message, downloadErrorStatus(e.reason));
		}
		throw e;
	}
});

skillsRoutes.delete('/companies/:companyId/skills/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const companySlug = await getCompanySlug(db, companyId);
	if (!companySlug) return err(c, 'NOT_FOUND', 'Company not found', 404);

	const removed = removeSkill(dataDir, companySlug, slug);
	if (!removed) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return c.json({ data: null }, 200);
});

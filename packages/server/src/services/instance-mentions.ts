import type { MentionCandidates } from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * Instance-wide mention resolution for the global CEO chat (and the per-channel
 * message renderers). Unlike the project-scoped resolve endpoints, candidates
 * are matched across every team, so a reference only resolves when it is
 * UNIQUE instance-wide: task identifiers are unique per team but can collide
 * across teams, and doc filenames / asset names / agent slugs collide commonly
 * (every Startup-template team has a captain, most projects have a prd.md).
 * Ambiguous references are omitted from the result and render as plain text —
 * a wrong link is worse than no link. Skills (KB docs) are instance-global and
 * slug-unique already, so they have no ambiguity clause.
 */

export interface InstanceResolvedTask {
	identifier: string;
	title: string;
	project_slug: string;
	status: string;
}

export interface InstanceResolvedKbDoc {
	slug: string;
	title: string;
	size: number;
	updated_at: string;
}

export interface InstanceResolvedProjectDoc {
	project_slug: string;
	filename: string;
	size: number;
	updated_at: string;
}

export interface InstanceResolvedAsset {
	project_slug: string;
	filename: string;
	id: string;
	content_type: string;
}

export interface InstanceResolvedAgent {
	slug: string;
	title: string;
	project_slug: string;
}

export interface InstanceMentionResolution {
	tasks: InstanceResolvedTask[];
	kb_docs: InstanceResolvedKbDoc[];
	project_docs: InstanceResolvedProjectDoc[];
	assets: InstanceResolvedAsset[];
	agents: InstanceResolvedAgent[];
}

export async function resolveInstanceMentions(
	db: Db,
	candidates: MentionCandidates,
): Promise<InstanceMentionResolution> {
	const out: InstanceMentionResolution = {
		tasks: [],
		kb_docs: [],
		project_docs: [],
		assets: [],
		agents: [],
	};

	if (candidates.tasks.length > 0) {
		const result = await db.query<InstanceResolvedTask>(
			`WITH m AS (
				SELECT i.identifier, i.title, i.status::text AS status, p.slug AS project_slug,
				       COUNT(*) OVER (PARTITION BY LOWER(i.identifier)) AS n
				FROM tasks i
				JOIN projects p ON p.id = i.project_id
				WHERE LOWER(i.identifier) = ANY($1::text[])
			)
			SELECT identifier, title, status, project_slug FROM m WHERE n = 1`,
			[candidates.tasks],
		);
		out.tasks = result.rows;
	}

	if (candidates.filenames.length > 0) {
		const docs = await db.query<InstanceResolvedProjectDoc>(
			`WITH m AS (
				SELECT p.slug AS project_slug, pd.slug AS filename,
				       octet_length(pd.content)::int AS size, pd.updated_at,
				       COUNT(*) OVER (PARTITION BY pd.slug) AS n
				FROM documents pd
				JOIN projects p ON p.id = pd.project_id
				WHERE pd.type = 'project_doc' AND pd.slug = ANY($1::text[])
			)
			SELECT project_slug, filename, size, updated_at FROM m WHERE n = 1`,
			[candidates.filenames],
		);
		out.project_docs = docs.rows;

		const kb = await db.query<InstanceResolvedKbDoc>(
			`SELECT slug, name AS title, octet_length(content)::int AS size, updated_at
			 FROM skills
			 WHERE LOWER(slug) = ANY($1::text[])`,
			[candidates.filenames.map((f) => f.toLowerCase())],
		);
		out.kb_docs = kb.rows;
	}

	if (candidates.assets.length > 0) {
		const result = await db.query<InstanceResolvedAsset>(
			`WITH m AS (
				SELECT p.slug AS project_slug, a.original_filename AS filename, a.id, a.content_type,
				       COUNT(*) OVER (PARTITION BY a.original_filename) AS n
				FROM assets a
				JOIN projects p ON p.id = a.project_id
				WHERE a.original_filename = ANY($1::text[])
			)
			SELECT project_slug, filename, id, content_type FROM m WHERE n = 1`,
			[candidates.assets],
		);
		out.assets = result.rows;
	}

	if (candidates.agents.length > 0) {
		// Teams and projects are 1:1 (UNIQUE(projects.team_id)), so the join is
		// total; HQ agents (CEO/Coach) resolve to the HQ project's slug.
		const result = await db.query<InstanceResolvedAgent>(
			`WITH m AS (
				SELECT ma.slug, ma.title, p.slug AS project_slug,
				       COUNT(*) OVER (PARTITION BY LOWER(ma.slug)) AS n
				FROM member_agents ma
				JOIN members mem ON mem.id = ma.id
				JOIN projects p ON p.team_id = mem.team_id
				WHERE ma.admin_status = 'enabled' AND LOWER(ma.slug) = ANY($1::text[])
			)
			SELECT slug, title, project_slug FROM m WHERE n = 1`,
			[candidates.agents],
		);
		out.agents = result.rows;
	}

	return out;
}

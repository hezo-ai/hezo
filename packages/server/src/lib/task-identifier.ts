import type { Db } from '../db/database';

export interface AllocatedIdentifier {
	number: number;
	identifier: string;
}

export async function allocateTaskIdentifier(
	db: Db,
	projectId: string,
): Promise<AllocatedIdentifier> {
	const result = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const row = result.rows[0];
	if (!row) throw new Error(`allocateTaskIdentifier: project ${projectId} not found`);
	return { number: row.number, identifier: `${row.task_prefix}-${row.number}` };
}

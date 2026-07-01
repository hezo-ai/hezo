import type { PGlite } from '@electric-sql/pglite';
import { TERMINAL_TASK_STATUSES } from '@hezo/shared';

/**
 * Run `fn` inside a BEGIN/COMMIT block. ROLLBACK on any thrown error before
 * rethrowing. Replaces hand-rolled `BEGIN`/try/COMMIT/catch/ROLLBACK scaffolding
 * at call sites — forgetting ROLLBACK becomes impossible.
 *
 * PGlite has no nested transaction support, so do not call this from inside
 * another `withTransaction`.
 */
export async function withTransaction<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
	await db.query('BEGIN');
	try {
		const result = await fn();
		await db.query('COMMIT');
		return result;
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
}

export interface TerminalStatusParams {
	placeholders: string;
	values: string[];
}

export function terminalStatusParams(startIdx: number, withCast = true): TerminalStatusParams {
	const cast = withCast ? '::task_status' : '';
	const placeholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${startIdx + i}${cast}`).join(', ');
	return { placeholders, values: [...TERMINAL_TASK_STATUSES] };
}

export interface UpdateSet {
	clauses: string[];
	params: unknown[];
	nextIdx: number;
}

export interface UpdateFieldSpec {
	column: string;
	value: unknown;
	cast?: string;
}

export function buildUpdateSet(fields: UpdateFieldSpec[], startIdx = 1): UpdateSet {
	const clauses: string[] = [];
	const params: unknown[] = [];
	let idx = startIdx;

	for (const f of fields) {
		if (f.value === undefined) continue;
		clauses.push(`${f.column} = $${idx}${f.cast ? `::${f.cast}` : ''}`);
		params.push(f.cast === 'jsonb' ? JSON.stringify(f.value) : f.value);
		idx++;
	}

	return { clauses, params, nextIdx: idx };
}

/**
 * Remove NUL (0x00) bytes from decoded text. Postgres `text`/`jsonb` columns reject NUL
 * on write, and NUL is valid UTF-8 so `TextDecoder` passes it through unchanged —
 * container output carrying binary noise must be scrubbed before it can be persisted.
 */
export function stripNulBytes(text: string): string {
	const NUL = String.fromCharCode(0);
	return text.includes(NUL) ? text.split(NUL).join('') : text;
}

const PG_FK_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

export function isFkViolation(err: unknown, constraintName?: string): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { code?: unknown; constraint?: unknown };
	if (e.code !== PG_FK_VIOLATION) return false;
	if (constraintName && e.constraint !== constraintName) return false;
	return true;
}

export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { code?: unknown; constraint?: unknown };
	if (e.code !== PG_UNIQUE_VIOLATION) return false;
	if (constraintName && e.constraint !== constraintName) return false;
	return true;
}

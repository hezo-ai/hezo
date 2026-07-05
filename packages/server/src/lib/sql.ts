import { TERMINAL_TASK_STATUSES } from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * Run `fn` inside a database transaction. Queries `fn` issues on the same
 * `db` are routed into the transaction (see `Db.transaction`), commit happens
 * on success, rollback on any thrown error. Nested calls join the ambient
 * transaction — the outermost block owns commit/rollback.
 *
 * @deprecated Call `db.transaction(cb)` directly in new code; `cb` receives
 * the pinned transaction handle explicitly.
 */
export async function withTransaction<T>(db: Db, fn: () => Promise<T>): Promise<T> {
	return db.transaction(() => fn());
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

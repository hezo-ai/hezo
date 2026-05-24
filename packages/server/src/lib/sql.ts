import { TERMINAL_TASK_STATUSES } from '@hezo/shared';

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

const PG_FK_VIOLATION = '23503';

export function isFkViolation(err: unknown, constraintName?: string): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { code?: unknown; constraint?: unknown };
	if (e.code !== PG_FK_VIOLATION) return false;
	if (constraintName && e.constraint !== constraintName) return false;
	return true;
}

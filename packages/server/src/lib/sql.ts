import { TERMINAL_ISSUE_STATUSES } from '@hezo/shared';

export interface TerminalStatusParams {
	placeholders: string;
	values: string[];
}

export function terminalStatusParams(startIdx: number, withCast = true): TerminalStatusParams {
	const cast = withCast ? '::issue_status' : '';
	const placeholders = TERMINAL_ISSUE_STATUSES.map((_, i) => `$${startIdx + i}${cast}`).join(', ');
	return { placeholders, values: [...TERMINAL_ISSUE_STATUSES] };
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

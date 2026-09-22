import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_SERVER_VERSION_NUM } from '../src/db/postgres-preflight';
import { utcDaySql, utcWindowStartSql } from '../src/lib/sql';

/**
 * SQL this server sends must run on the oldest PostgreSQL it says it supports.
 * Nothing else can catch a newer function: CI's external leg runs 16 and the
 * embedded engine is 16, so a call an instance on 14 cannot make passes green
 * here and refuses every dispatch there.
 */
const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return name.endsWith('.ts') ? [path] : [];
	});
}

/**
 * How many arguments each `date_trunc(` call in `source` takes, counting commas
 * at the call's own depth so a nested `now()` or a cast does not read as one.
 */
function dateTruncArities(source: string): number[] {
	const arities: number[] = [];
	for (let i = source.indexOf('date_trunc('); i !== -1; i = source.indexOf('date_trunc(', i + 1)) {
		let depth = 0;
		let args = 1;
		for (let j = i + 'date_trunc'.length; j < source.length; j++) {
			const ch = source[j];
			if (ch === '(') depth++;
			else if (ch === ')') {
				depth--;
				if (depth === 0) break;
			} else if (ch === ',' && depth === 1) args++;
		}
		arities.push(args);
	}
	return arities;
}

describe('SQL kept to the supported PostgreSQL floor', () => {
	it('never calls the three-argument date_trunc, which arrived in PostgreSQL 16', () => {
		expect(MIN_SERVER_VERSION_NUM).toBeLessThan(160_000);
		const offenders = sourceFiles(SRC).filter((path) =>
			dateTruncArities(readFileSync(path, 'utf8')).some((arity) => arity > 2),
		);
		expect(offenders).toEqual([]);
	});

	it('truncates a UTC window through the helpers, which the session time zone cannot shift', () => {
		expect(utcWindowStartSql("'month'")).toBe(
			"(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
		);
		expect(utcDaySql('ue.created_at')).toBe(
			"date_trunc('day', ue.created_at AT TIME ZONE 'UTC')::date",
		);
	});
});

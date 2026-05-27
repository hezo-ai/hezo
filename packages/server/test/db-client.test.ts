import { describe, expect, it } from 'vitest';
import { isRecoverablePgInitError } from '../src/db/client';

describe('isRecoverablePgInitError', () => {
	it('matches PGlite WASM init failures', () => {
		expect(
			isRecoverablePgInitError(
				new Error('Unreachable code should not be executed (evaluating this.mod._pg_initdb())'),
			),
		).toBe(true);
	});

	it('ignores unrelated errors', () => {
		expect(isRecoverablePgInitError(new Error('connection refused'))).toBe(false);
	});
});

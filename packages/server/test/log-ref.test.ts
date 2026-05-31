import { describe, expect, it } from 'vitest';
import { ref } from '../src/lib/log-ref';

describe('ref', () => {
	const id = '3d8317ca-fd4b-4140-a42d-1fa97d187e34';

	it('formats a friendly label alongside the uuid', () => {
		expect(ref('OP-42', id)).toBe(`OP-42 (${id})`);
		expect(ref('captain/OP-42', id)).toBe(`captain/OP-42 (${id})`);
	});

	it('falls back to the bare uuid when no label is available', () => {
		expect(ref(undefined, id)).toBe(id);
		expect(ref(null, id)).toBe(id);
		expect(ref('', id)).toBe(id);
	});
});

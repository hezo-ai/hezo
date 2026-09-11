import { describe, expect, it } from 'vitest';
import { FRAME_ANCESTORS_NONE, refuseFraming } from '../src/middleware/framing';

describe('refuseFraming', () => {
	it('adds the policy to a response that has none', () => {
		const headers = new Headers({ 'Content-Type': 'text/html' });
		refuseFraming(headers);
		expect(headers.get('Content-Security-Policy')).toBe(FRAME_ANCESTORS_NONE);
	});

	it('leaves a policy a route wrote for itself untouched', () => {
		// The sandbox the asset route serves agent-authored HTML under, which the
		// app frames in its own viewer.
		const own = 'sandbox allow-scripts';
		const headers = new Headers({ 'Content-Security-Policy': own });
		refuseFraming(headers);
		expect(headers.get('Content-Security-Policy')).toBe(own);
	});
});

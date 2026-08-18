import {
	isRunCancelReason,
	RUN_CANCEL_BEHAVIOUR,
	RUN_CANCEL_REASONS,
	RunCancelReason,
	runCancelOffersRetry,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

describe('RunCancelReason', () => {
	it('describes every reason, so a new one cannot fall through to a default', () => {
		for (const reason of RUN_CANCEL_REASONS) {
			expect(RUN_CANCEL_BEHAVIOUR[reason]).toBeDefined();
		}
		expect(Object.keys(RUN_CANCEL_BEHAVIOUR).sort()).toEqual([...RUN_CANCEL_REASONS].sort());
	});

	it('offers a retry only where work is owed and nothing is carrying it', () => {
		// `handed_back` owes work too, but the wakeup is already queued - a button
		// there is dead at best and a double dispatch at worst.
		expect(RUN_CANCEL_BEHAVIOUR[RunCancelReason.Abandoned]).toEqual({
			workStillOwed: true,
			offerRetry: true,
		});
		expect(RUN_CANCEL_BEHAVIOUR[RunCancelReason.HandedBack]).toEqual({
			workStillOwed: true,
			offerRetry: false,
		});
		// Nobody wants the work, so neither of these owes anything.
		expect(RUN_CANCEL_BEHAVIOUR[RunCancelReason.OperatorTerminated].workStillOwed).toBe(false);
		expect(RUN_CANCEL_BEHAVIOUR[RunCancelReason.WorkWithdrawn].workStillOwed).toBe(false);
	});

	it('recognises stored values and rejects everything else', () => {
		expect(isRunCancelReason('abandoned')).toBe(true);
		expect(isRunCancelReason('operator_terminated')).toBe(true);
		expect(isRunCancelReason('something_a_newer_server_wrote')).toBe(false);
		expect(isRunCancelReason(null)).toBe(false);
		expect(isRunCancelReason(undefined)).toBe(false);
		expect(isRunCancelReason(7)).toBe(false);
	});

	it('answers false for an unknown reason rather than throwing mid-render', () => {
		// The version-skew case: a run cancelled by a newer server, or by one old
		// enough to carry no attribution at all. Silence is the safe answer, since
		// inventing a Retry could re-dispatch work somebody deliberately stopped.
		expect(runCancelOffersRetry('abandoned')).toBe(true);
		expect(runCancelOffersRetry('handed_back')).toBe(false);
		expect(runCancelOffersRetry('a_reason_from_the_future')).toBe(false);
		expect(runCancelOffersRetry(null)).toBe(false);
		expect(runCancelOffersRetry(undefined)).toBe(false);
	});
});

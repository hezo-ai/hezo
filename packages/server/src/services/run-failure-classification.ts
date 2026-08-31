/**
 * Whether a run failure is worth another attempt.
 *
 * The question is not how bad the failure was but whether the next attempt will
 * see the same thing. A dropped output stream or a vanished driver is a fact
 * about this attempt; a rejected credential, a bad MCP injection or a
 * misconfigured connector is a fact about the instance, and a retry reproduces
 * it exactly - having claimed a container first.
 */
/**
 * Two entry points, one vocabulary. {@link classifyRunFailure} below answers for
 * a *thrown* failure, keyed on its type; `classifyRuntimeError`
 * (`agent-stream-parser.ts`) answers for a failure a runtime *reported on its
 * stream*, keyed on the provider's own wording. They return the same
 * `RunFailureClass`, so the exec path and the parsed path cannot drift into
 * disagreeing about what a retry is for.
 */
export const RunFailureClass = {
	Transient: 'transient',
	Permanent: 'permanent',
} as const;
export type RunFailureClass = (typeof RunFailureClass)[keyof typeof RunFailureClass];

/**
 * The failures known to be worth retrying, keyed by `Error.name`.
 *
 * Keyed by name rather than by constructor for two reasons. The throwers live
 * under `sandbox/`, `egress/` and `runtime-adapters/`, and none of them may take a
 * dependency on run-retry policy to be classified - the alternative inverts that
 * dependency at every throw site. And it keeps this module importing nothing, so
 * it can never close a cycle with `agent-runner` or `containers`.
 *
 * **No provider-specific type may be listed here.** This module sits above the
 * `ContainerEngine` seam, and a row naming a backend is the conditional that
 * seam exists to prevent. A provider's failure earns a retry by being translated
 * into a backend-agnostic type inside that provider's own adapter, which is what
 * `ExecStreamLostError` already documents itself as doing. The unit test asserts
 * the shape rather than trusting this paragraph.
 */
const TRANSIENT_ERROR_NAMES: Record<string, true> = {
	// The container's output stream closed while the command was still going:
	// the transport lost the run, not the agent.
	ExecStreamLostError: true,
	// Tunnel ports are per-container, so a redispatch can land somewhere with
	// room. Nothing about the run itself is wrong.
	TunnelPortsExhaustedError: true,
	// The container was stopped or removed out from under the run - a provider's
	// idle timer, a reclaim, an operator. The next attempt gets a container of
	// its own and finds nothing wrong. Not a quota or memory-cap refusal, which
	// is a fact about the instance and reproduces exactly.
	ContainerUnreachableError: true,
};

/**
 * Unrecognised means permanent, deliberately.
 *
 * A retry is a recovery mechanism for a named, known-transient condition, not a
 * default posture; minting one for a failure nobody has classified is the
 * "degrades to" behaviour the codebase rules out. The failure direction is also
 * asymmetric - a permanent verdict is loud, ending in a terminal row carrying
 * the real error and a notice on the task thread, while a transient one is
 * silent and spends a container per attempt. Reclassifying a newly-understood
 * transient failure is one row above.
 */
export function classifyRunFailure(error: unknown): RunFailureClass {
	const name = error instanceof Error ? error.name : '';
	return TRANSIENT_ERROR_NAMES[name] ? RunFailureClass.Transient : RunFailureClass.Permanent;
}

/** The transient names, for the guard test. Not for branching on. */
export function transientRunFailureNames(): string[] {
	return Object.keys(TRANSIENT_ERROR_NAMES);
}

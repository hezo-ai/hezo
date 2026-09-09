// Config for the server the browser suite spawns (playwright.config.ts passes
// --config). Only settings that need to differ from production defaults live
// here; the test-only switches stay env vars, since they are not operator
// configuration and must never appear in a real instance's config file.
module.exports = {
	// Telemetry defaults on; a CI run crossing the daily cron window would fire a
	// real outbound report. Tests never phone home.
	telemetry: { enabled: false },
	// The browser suite *is* the deployer of this instance, so it configures it the
	// way a managed deployment does. Nothing asserts on the "managed by" notice
	// this puts on the settings page; `managedBy` is required by the schema and is
	// answered honestly here rather than worked around.
	policy: {
		managedBy: 'the Hezo browser suite',
		pinned: {
			// **These containers are not real, so the budget that bounds them must not
			// be.** The suite creates a fresh project per spec and expects each to get
			// a container, and every path that brings one up is now gated on the
			// instance memory budget - correctly, since a container started around
			// that gate takes memory queued runs are told they cannot have. Left at
			// the automatic default, that budget is derived from the *runner's* RAM
			// and admits a handful of containers, so specs beyond the first few sat
			// waiting for a container the gate would never allow.
			//
			// Pinned rather than raised in a fixture: it is a property of this
			// deployment, not of any one test, and the fake engine's containers cost
			// the runner nothing to "start". A real instance derives its own.
			maxContainerMemoryGb: 512,
		},
	},
	jobs: {
		// 1Hz so agent-flow specs react promptly.
		wakeupCron: '* * * * * *',
		heartbeatCron: '* * * * * *',
		wakeupCoalescingMs: 100,
		// Wakeups/heartbeats stay at 1Hz, but container-status reconciliation has no
		// sub-second consumer here (fake docker sets status synchronously on
		// create/start). Drop it from 1Hz to every 10s so it stops compounding CPU
		// load on the 2-core runner - the largest cheap win against the
		// page-load-timeout flakes.
		containerSyncCron: '*/10 * * * * *',
	},
};

// Config for the server the browser suite spawns (playwright.config.ts passes
// --config). Only settings that need to differ from production defaults live
// here; the test-only switches stay env vars, since they are not operator
// configuration and must never appear in a real instance's config file.
module.exports = {
	// Telemetry defaults on; a CI run crossing the daily cron window would fire a
	// real outbound report. Tests never phone home.
	telemetry: { enabled: false },
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

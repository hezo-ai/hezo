// Vitest global setup — grows as test infrastructure matures.
import { quietTestLogs } from './helpers/log-level';

// Suppress expected `[info]` chatter so the test log stays readable; warn/error
// remain visible. Overridable via HEZO_LOG_LEVEL.
quietTestLogs();

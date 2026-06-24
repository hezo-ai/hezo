// Preloaded by `bun test` via packages/server/bunfig.toml ([test] preload).
// Mirrors the vitest setup: quiet the app logger to `warn` during the
// Bun-native tier so expected `[info]` chatter doesn't bury real signal.
// Overridable via HEZO_LOG_LEVEL.
import { quietTestLogs } from '../helpers/log-level';

quietTestLogs();

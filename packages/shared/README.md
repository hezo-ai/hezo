# @hezo/shared

Shared TypeScript types and constants used across Hezo packages.

## Usage

Import from `@hezo/shared` in any workspace package:

```typescript
import { DEFAULT_PORT, AgentRuntime, type HezoConfig } from "@hezo/shared";
```

## Exports

### Types

- `HezoConfig` — server configuration (port, dataDir, masterKey, etc.)
- `ConnectConfig` — OAuth gateway configuration
- `MasterKeyState` — `"unset" | "locked" | "unlocked"`

### Enums

All enums use the `as const` object pattern (not TypeScript `enum`):

`MemberType`, `AgentRuntime`, `AgentStatus`, `IssueStatus`, `IssuePriority`, `CommentContentType`, `ApprovalType`, `ApprovalStatus`, `MembershipRole`, `PlatformType`, `ConnectionStatus`, and more.

### Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_PORT` | `3100` |
| `DEFAULT_WEB_PORT` | `5173` |
| `DEFAULT_DATA_DIR` | `~/.hezo` |
| `CANARY_PLAINTEXT` | `CANARY` |

## Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Compile TypeScript |
| `bun run typecheck` | Type-check without emitting |

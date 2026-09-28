/**
 * Codex features no Hezo session uses, switched off wherever Hezo starts Codex:
 * the run's config file and the completeness judge's own `codex exec`.
 *
 * - `apps`: Codex surfaces the apps connected to the signed-in ChatGPT account
 *   as tools, in a namespace of their own (`codex_apps`), beside the MCP servers
 *   Hezo configures. They are the wrong tenant: authorized against that account
 *   rather than the project's connection, so they answer 404 on the project's
 *   own resources - which reads to an agent as the resource not existing. Two
 *   runs diagnosed exactly that as a Hezo connector fault. Codex also documents
 *   that "app and connector traffic is not controlled by the sandboxed-command
 *   network proxy or its domain allowlist", so they are an egress path outside
 *   the run's control as well. openai/codex#17588 reported `apps.<id>.enabled`
 *   being ignored - but under a `[profiles.*]` section, and Hezo writes top-level
 *   keys, so that report does not apply here. It is why RUNTIME_PROMPT_NOTES still
 *   carries a short Codex note rather than relying on this key alone.
 * - `plugins`: Codex syncs its curated plugins repository into every fresh
 *   CODEX_HOME: a 25 MB download and about 98 MB on disk, per session, for
 *   plugins no Hezo session uses. Measured on 0.149.0 and 0.156.0: with this off
 *   there is no clone and no warning, and MCP, web search and the apps switch are
 *   unaffected.
 *
 * Each is the feature gate rather than a per-item default. If Codex stops
 * starting after a CLI bump, check these keys first: an unrecognised key is the
 * failure mode that breaks a whole config.
 */
export const CODEX_FEATURES_OFF = ['apps', 'plugins'] as const;

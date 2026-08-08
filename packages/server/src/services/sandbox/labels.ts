/**
 * The labels Hezo stamps on every container it creates, whichever backend made
 * it.
 *
 * **One home, deliberately dependency-free.** These were previously declared
 * three times - in `provisionContainer`, which sets them, and again in
 * `uninstall.ts` and `switch-backend.ts`, which query them - because importing
 * the setter would have dragged `containers.ts`'s whole dependency graph into a
 * CLI subcommand. That comment ("if the label key ever changes in
 * `provisionContainer`, change it here too") was an admission that the coupling
 * was unenforced, and it drifted: the two query sites disagreed about which
 * label scopes a sweep to *this* instance. This module imports nothing, so
 * every one of them can share it.
 *
 * Only {@link INSTANCE_LABEL} identifies an owner. The other two are
 * descriptive: several Hezo instances can share one provider account, and every
 * container any of them creates carries `hezo.team` and `hezo.project`, so a
 * query on either reaches across instances. Anything that **destroys** must
 * scope on `hezo.instance=<id>`.
 */

/**
 * Names the instance that created the container. On local Docker this is
 * belt-and-braces; on a managed backend it is the thing that makes destroying
 * anything safe at all.
 *
 * Its value is `getOrCreateInstanceId`, which outlives the database on purpose -
 * a `--reset` used to mint a new one and strand every container the previous
 * life had created, unreapable and (on a managed backend) still billing.
 */
export const INSTANCE_LABEL = 'hezo.instance';

/** The slug of the team whose project the container belongs to. Descriptive only. */
export const TEAM_LABEL = 'hezo.team';

/** The slug of the project the container belongs to. Descriptive only. */
export const PROJECT_LABEL = 'hezo.project';

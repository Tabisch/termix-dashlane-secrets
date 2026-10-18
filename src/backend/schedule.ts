import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { canIssueUserTokens } from "./core-credentials.js";
import type { Repository } from "./repository.js";
import type { Syncer } from "./sync.js";

const TICK_MS = 60_000;

/**
 * Checks once a minute for connections due a sync, so a change to the admin
 * interval applies without a restart. Each sync runs as its own user.
 * Failures are recorded on the connection and never thrown, so one broken
 * account can't spend the plugin's error budget.
 *
 * A background sync has no request to borrow a session from, so it needs
 * ctx.auth.issueUserToken (plugin API 1.3, Termix 26.10.2). On older servers
 * the tick does nothing and people use Sync now.
 */
export function startScheduledSync(
  ctx: PluginContext,
  repo: Repository,
  syncer: Syncer,
): void {
  ctx.schedule.every(
    TICK_MS,
    async () => {
      await runDueSyncs(ctx, repo, syncer);
    },
    {
      jitterMs: 10_000,
    },
  );
}

export async function runDueSyncs(
  ctx: PluginContext,
  repo: Repository,
  syncer: Syncer,
  now = Date.now(),
): Promise<number> {
  const minutes = Number(
    (await ctx.settings.get<number>("syncIntervalMinutes")) ?? 60,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  if (!canIssueUserTokens(ctx)) return 0;

  let ran = 0;
  for (const connection of await repo.listConnections()) {
    if (!connection.collections.length) continue;
    const last = connection.lastSyncAt ? Date.parse(connection.lastSyncAt) : 0;
    if (now - last < minutes * 60_000) continue;
    ran += 1;
    try {
      await ctx.asUser(connection.userId, () => syncer.run(connection.userId));
    } catch (error) {
      ctx.log.warn(
        `scheduled dashlane sync failed for user ${connection.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return ran;
}

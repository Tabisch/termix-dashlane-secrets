import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { connections, items } from "./tables.js";
import { createRepository } from "./repository.js";
import { registerRoutes } from "./routes.js";
import { startScheduledSync } from "./schedule.js";
import { createSyncer } from "./sync.js";

export async function activate(ctx: PluginContext) {
  const connectionsTable = await ctx.db.define(connections);
  const itemsTable = await ctx.db.define(items);
  const repo = createRepository(ctx, connectionsTable, itemsTable);
  const syncer = createSyncer({ ctx, repo });

  registerRoutes(ctx.http.router<Router>(), ctx, repo, syncer);
  startScheduledSync(ctx, repo, syncer);
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}

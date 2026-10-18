import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { DashlaneApiError } from "./dashlane/api.js";
import { DeviceKeyFormatError, parseDeviceKey } from "./dashlane/device-key.js";
import {
  canIssueUserTokens,
  requestToken,
  type CoreSession,
} from "./core-credentials.js";
import type { Repository } from "./repository.js";
import { DEVICE_KEY_SECRET, SyncError, type Syncer } from "./sync.js";

const MAX_COLLECTIONS = 200;
const MAX_NAME_LENGTH = 255;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Answers a failed Dashlane or sync call without spending the error budget. */
function sendFailure(res: Response, error: unknown) {
  if (error instanceof SyncError) {
    const status =
      error.code === "not_connected" ? 404 : error.code === "busy" ? 409 : 422;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  if (error instanceof DeviceKeyFormatError) {
    return res.status(400).json({ error: error.message, code: "invalid_key" });
  }
  if (error instanceof DashlaneApiError) {
    return res
      .status(502)
      .json({ error: error.message, code: error.code ?? "dashlane_error" });
  }
  return res.status(502).json({ error: errorMessage(error) });
}

export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  repo: Repository,
  syncer: Syncer,
): void {
  router.use(ctx.rbac.require("use") as never);

  const actor = () => ctx.currentActor() as string;

  /** Reaches Termix with the caller's own session, so it works on API 1.2. */
  const sessionOf = (req: Request): CoreSession => {
    const token = requestToken(req as never);
    return token ? { token } : { userId: actor() };
  };

  async function status(userId: string) {
    const connection = await repo.getConnection(userId);
    const interval =
      (await ctx.settings.get<number>("syncIntervalMinutes")) ?? 60;
    if (!connection) {
      return {
        connected: false,
        syncIntervalMinutes: interval,
        scheduledSyncSupported: canIssueUserTokens(ctx),
      };
    }
    const items = await repo.listItems(userId);
    return {
      connected: true,
      syncIntervalMinutes: interval,
      scheduledSyncSupported: canIssueUserTokens(ctx),
      login: connection.login,
      collections: connection.collections,
      availableCollections: connection.availableCollections,
      removeMissing: connection.removeMissing,
      lastSyncAt: connection.lastSyncAt,
      lastStatus: connection.lastStatus,
      lastError: connection.lastError,
      lastSummary: connection.lastSummary,
      items: items
        .map(({ title, collection, credentialId, updatedAt }) => ({
          title,
          collection,
          credentialId,
          updatedAt,
        }))
        .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")),
    };
  }

  /**
   * @openapi
   * /plugin-api/dashlane-secrets/status:
   *   get:
   *     summary: The signed-in user's Dashlane connection, chosen collections and imported credentials
   *     tags:
   *       - Dashlane
   *     responses:
   *       200:
   *         description: Whether Dashlane is connected, and if so what is synced and how the last sync went
   */
  router.get("/status", async (_req: Request, res: Response) => {
    res.json(await status(actor()));
  });

  /**
   * @openapi
   * /plugin-api/dashlane-secrets/connect:
   *   post:
   *     summary: Connect a Dashlane account with a service device key
   *     description: Checks the key by reading the vault, then stores it encrypted for the signed-in user. The key is never sent back.
   *     tags:
   *       - Dashlane
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               deviceKey:
   *                 type: string
   *                 description: The dls_... value printed by dcli devices register
   *     responses:
   *       200:
   *         description: Connected. The body is the new status, with the vault's collections
   *       400:
   *         description: Not a service device key
   *       502:
   *         description: Dashlane refused the key or could not be reached
   */
  router.post("/connect", async (req: Request, res: Response) => {
    const raw =
      typeof req.body?.deviceKey === "string" ? req.body.deviceKey : "";
    if (!raw.trim() || raw.length > 10_000) {
      return res
        .status(400)
        .json({ error: "deviceKey is required", code: "invalid_key" });
    }
    try {
      const key = parseDeviceKey(raw);
      const availableCollections = await syncer.collections(key);
      const userId = actor();
      const previous = await repo.getConnection(userId);
      await ctx.secrets.set(DEVICE_KEY_SECRET, raw.trim());
      await repo.saveConnection(userId, {
        login: key.login,
        availableCollections,
        // A different account's collections mean nothing here.
        ...(previous && previous.login !== key.login
          ? { collections: [] }
          : {}),
      });
      ctx.log.info(`dashlane connected for user ${userId}`);
      res.json(await status(userId));
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  /**
   * @openapi
   * /plugin-api/dashlane-secrets/config:
   *   put:
   *     summary: Choose which Dashlane collections to import
   *     tags:
   *       - Dashlane
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               collections:
   *                 type: array
   *                 items:
   *                   type: string
   *               removeMissing:
   *                 type: boolean
   *                 description: Delete credentials this plugin made when their login leaves the chosen collections
   *     responses:
   *       200:
   *         description: Saved. The body is the new status
   *       400:
   *         description: Invalid collections
   *       404:
   *         description: Dashlane is not connected
   */
  router.put("/config", async (req: Request, res: Response) => {
    const { collections, removeMissing } = req.body ?? {};
    if (
      !Array.isArray(collections) ||
      collections.length > MAX_COLLECTIONS ||
      collections.some(
        (name) =>
          typeof name !== "string" ||
          !name.trim() ||
          name.length > MAX_NAME_LENGTH,
      )
    ) {
      return res
        .status(400)
        .json({ error: "collections must be a list of names" });
    }
    if (removeMissing !== undefined && typeof removeMissing !== "boolean") {
      return res
        .status(400)
        .json({ error: "removeMissing must be true or false" });
    }
    const userId = actor();
    if (!(await repo.getConnection(userId))) {
      return res
        .status(404)
        .json({ error: "Dashlane is not connected", code: "not_connected" });
    }
    const unique = [
      ...new Set((collections as string[]).map((name) => name.trim())),
    ];
    await repo.saveConnection(userId, {
      collections: unique,
      ...(removeMissing !== undefined ? { removeMissing } : {}),
    });
    res.json(await status(userId));
  });

  /**
   * @openapi
   * /plugin-api/dashlane-secrets/collections/refresh:
   *   post:
   *     summary: Read the vault's collections again
   *     tags:
   *       - Dashlane
   *     responses:
   *       200:
   *         description: The new status, with the vault's current collections
   *       404:
   *         description: Dashlane is not connected
   *       502:
   *         description: Dashlane could not be reached
   */
  router.post("/collections/refresh", async (_req: Request, res: Response) => {
    const userId = actor();
    try {
      if (!(await repo.getConnection(userId))) {
        throw new SyncError("Dashlane is not connected", "not_connected");
      }
      const availableCollections = await syncer.collections(
        await syncer.deviceKey(),
      );
      await repo.saveConnection(userId, { availableCollections });
      res.json(await status(userId));
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  /**
   * @openapi
   * /plugin-api/dashlane-secrets/sync:
   *   post:
   *     summary: Sync the chosen collections into Termix credentials now
   *     tags:
   *       - Dashlane
   *     responses:
   *       200:
   *         description: Synced. The body is the new status, with what changed in lastSummary
   *       404:
   *         description: Dashlane is not connected
   *       409:
   *         description: A sync is already running
   *       502:
   *         description: Dashlane or Termix refused part of the sync. lastError has the reason
   */
  router.post("/sync", async (req: Request, res: Response) => {
    const userId = actor();
    try {
      await syncer.run(userId, sessionOf(req));
      res.json(await status(userId));
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  /**
   * @openapi
   * /plugin-api/dashlane-secrets/connect:
   *   delete:
   *     summary: Disconnect Dashlane and forget the device key
   *     tags:
   *       - Dashlane
   *     parameters:
   *       - in: query
   *         name: removeCredentials
   *         schema:
   *           type: boolean
   *         description: Also delete the credentials this plugin imported
   *     responses:
   *       200:
   *         description: Disconnected
   *       502:
   *         description: An imported credential could not be deleted. Nothing was disconnected
   */
  router.delete("/connect", async (req: Request, res: Response) => {
    const userId = actor();
    if (req.query.removeCredentials === "true") {
      const items = await repo.listItems(userId);
      if (items.length) {
        try {
          const core = await syncer.coreFor(sessionOf(req));
          for (const item of items) await core.remove(item.credentialId);
        } catch (error) {
          return sendFailure(res, error);
        }
      }
    }
    await ctx.secrets.delete(DEVICE_KEY_SECRET);
    await repo.deleteConnection(userId);
    ctx.log.info(`dashlane disconnected for user ${userId}`);
    res.json({ connected: false });
  });
}

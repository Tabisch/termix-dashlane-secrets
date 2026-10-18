import crypto from "node:crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { getLatestContent } from "./dashlane/api.js";
import { createDecryptor } from "./dashlane/crypto.js";
import { parseDeviceKey, type DeviceKey } from "./dashlane/device-key.js";
import {
  buildVault,
  type Vault,
  type VaultCredential,
} from "./dashlane/vault.js";
import {
  coreCredentialsFor,
  type CoreCredentials,
  type CredentialInput,
} from "./core-credentials.js";
import type { CollectionInfo, Repository, SyncSummary } from "./repository.js";

/** The ctx.secrets key holding the acting user's service device key. */
export const DEVICE_KEY_SECRET = "deviceKey";

/** Tag on every credential this plugin makes, so people can filter by it. */
export const CREDENTIAL_TAG = "dashlane";

/**
 * The tag that names one Dashlane login: "dashlane:" and its Dashlane id.
 * The id never changes, so the tag stays the same across syncs, edits and a
 * credential being made again, and other plugins (NetBox Sync) can find the
 * credential by it.
 */
export function credentialIdTag(dashlaneId: string): string {
  return `${CREDENTIAL_TAG}:${dashlaneId}`;
}

/** The scheme this plugin resolves in a credential's password at connect. */
export const SECRET_SCHEME = "dashlane";

/**
 * What a credential holds instead of the password with password references
 * on: Termix hands it to this plugin's resolver when a host connects.
 */
export function passwordReference(dashlaneId: string): string {
  return `${SECRET_SCHEME}://${dashlaneId}/password`;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: "not_connected" | "busy" | "decrypt_failed",
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export interface SyncDeps {
  ctx: PluginContext;
  repo: Repository;
}

export async function loadVault(
  ctx: PluginContext,
  key: DeviceKey,
): Promise<Vault> {
  const latest = await getLatestContent(ctx.fetch, key);
  const vault = await buildVault(
    latest.transactions ?? [],
    createDecryptor(key.masterPassword),
  );
  if (
    vault.failed > 0 &&
    !vault.credentials.length &&
    !vault.collections.length
  ) {
    throw new SyncError(
      "The vault could not be decrypted. If the master password changed, register a new device key.",
      "decrypt_failed",
    );
  }
  return vault;
}

export function collectionInfos(vault: Vault): CollectionInfo[] {
  const credentialIds = new Set(vault.credentials.map((c) => c.id));
  const byName = new Map<string, Set<string>>();
  for (const collection of vault.collections) {
    const members = byName.get(collection.name) ?? new Set<string>();
    for (const id of collection.itemIds) {
      if (credentialIds.has(id)) members.add(id);
    }
    byName.set(collection.name, members);
  }
  return [...byName.entries()].map(([name, members]) => ({
    name,
    items: members.size,
  }));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return "";
  }
}

export function toCredentialInput(
  credential: VaultCredential,
  collection: string,
  useReference = false,
): CredentialInput {
  const username =
    credential.login || credential.email || credential.secondaryLogin;
  return {
    name:
      credential.title ||
      hostnameOf(credential.url) ||
      username ||
      "Dashlane login",
    description: credential.url,
    folder: collection,
    tags: [CREDENTIAL_TAG, credentialIdTag(credential.id)],
    username,
    password: useReference
      ? passwordReference(credential.id)
      : credential.password,
  };
}

function hashInput(input: CredentialInput): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

/**
 * Picks the logins in the chosen collections. A login in several of them is
 * filed under the first one in the user's order.
 */
export function selectCredentials(
  vault: Vault,
  chosen: string[],
): Map<string, { credential: VaultCredential; collection: string }> {
  const credentials = new Map(vault.credentials.map((c) => [c.id, c]));
  const selected = new Map<
    string,
    { credential: VaultCredential; collection: string }
  >();
  for (const name of chosen) {
    const wanted = name.trim().toLowerCase();
    for (const collection of vault.collections) {
      if (collection.name.toLowerCase() !== wanted) continue;
      for (const id of collection.itemIds) {
        const credential = credentials.get(id);
        if (credential && !selected.has(id)) {
          selected.set(id, { credential, collection: collection.name });
        }
      }
    }
  }
  return selected;
}

export function createSyncer(deps: SyncDeps) {
  const { ctx, repo } = deps;
  const fetchVault = (key: DeviceKey) => loadVault(ctx, key);
  const coreFor = (userId: string): Promise<CoreCredentials> =>
    coreCredentialsFor(ctx, userId);
  const running = new Set<string>();

  /** Reads the acting user's device key. Must run as that user. */
  async function deviceKey(): Promise<DeviceKey> {
    const raw = await ctx.secrets.get(DEVICE_KEY_SECRET);
    if (!raw) {
      throw new SyncError("Dashlane is not connected", "not_connected");
    }
    return parseDeviceKey(raw);
  }

  async function syncOnce(userId: string): Promise<SyncSummary> {
    const connection = await repo.getConnection(userId);
    if (!connection) {
      throw new SyncError("Dashlane is not connected", "not_connected");
    }
    const vault = await fetchVault(await deviceKey());
    const selected = selectCredentials(vault, connection.collections);
    const summary: SyncSummary = {
      created: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
    };

    const imported = new Map(
      (await repo.listItems(userId)).map((item) => [item.dashlaneId, item]),
    );
    // Only ask for a Termix session when something has to change.
    const needsCore =
      [...imported.keys()].some((id) => !selected.has(id)) ||
      [...selected.entries()].some(
        ([id, { credential, collection }]) =>
          credential.password &&
          imported.get(id)?.contentHash !==
            hashInput(
              toCredentialInput(
                credential,
                collection,
                connection.passwordReferences,
              ),
            ),
      );
    const core = needsCore ? await coreFor(userId) : null;

    try {
      for (const [id, { credential, collection }] of selected) {
        if (!credential.password) {
          // Termix needs a password for a password credential.
          summary.skipped += 1;
          continue;
        }
        const input = toCredentialInput(
          credential,
          collection,
          connection.passwordReferences,
        );
        const contentHash = hashInput(input);
        const previous = imported.get(id);
        if (previous && previous.contentHash === contentHash) {
          summary.unchanged += 1;
          continue;
        }
        let credentialId = previous?.credentialId;
        if (
          credentialId !== undefined &&
          (await core!.update(credentialId, input))
        ) {
          summary.updated += 1;
        } else {
          // New, or deleted in Termix since: make it again.
          credentialId = await core!.create(input);
          summary.created += 1;
        }
        await repo.saveItem(userId, {
          dashlaneId: id,
          credentialId,
          collection,
          title: input.name,
          contentHash,
        });
      }

      // A vault that only partly decrypted could be missing items that still
      // exist, so nothing is removed on such a run. Nor is anything from a
      // chosen collection the vault no longer has: that is as likely to be a
      // format we failed to read as a deleted collection, and unticking it
      // in the tab removes its credentials on purpose.
      const chosen = new Set(
        connection.collections.map((n) => n.toLowerCase()),
      );
      const present = new Set(
        vault.collections.map((c) => c.name.toLowerCase()),
      );
      if (vault.failed === 0) {
        for (const [id, item] of imported) {
          if (selected.has(id)) continue;
          const from = item.collection.toLowerCase();
          if (chosen.has(from) && !present.has(from)) continue;
          if (connection.removeMissing) {
            await core!.remove(item.credentialId);
            summary.removed += 1;
          }
          await repo.deleteItem(userId, id);
        }
      }
    } finally {
      await repo.persist();
    }

    await repo.saveConnection(userId, {
      availableCollections: collectionInfos(vault),
      lastSyncAt: new Date().toISOString(),
      lastStatus: "ok",
      lastError: null,
      lastSummary: summary,
    });
    return summary;
  }

  return {
    deviceKey,
    coreFor,

    /** Syncs one user. Must run as that user (a route, or inside ctx.asUser). */
    async run(userId: string): Promise<SyncSummary> {
      if (running.has(userId)) {
        throw new SyncError("A sync is already running", "busy");
      }
      running.add(userId);
      try {
        return await syncOnce(userId);
      } catch (error) {
        if (!(error instanceof SyncError && error.code === "not_connected")) {
          await repo
            .saveConnection(userId, {
              lastSyncAt: new Date().toISOString(),
              lastStatus: "error",
              lastError: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
        throw error;
      } finally {
        running.delete(userId);
      }
    },

    /** Lists the vault's collections with the given key, without saving anything. */
    async collections(key: DeviceKey): Promise<CollectionInfo[]> {
      return collectionInfos(await fetchVault(key));
    },
  };
}

export type Syncer = ReturnType<typeof createSyncer>;

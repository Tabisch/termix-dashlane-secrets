import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { parseDeviceKey, type DeviceKey } from "./dashlane/device-key.js";
import { normalizeId, type Vault } from "./dashlane/vault.js";
import type { Repository } from "./repository.js";
import { DEVICE_KEY_SECRET, SECRET_SCHEME, selectCredentials } from "./sync.js";

/**
 * Resolves "dashlane://<id>/password" references, the way the Secret Sources
 * plugin resolves "op://...": Termix calls this when a host whose credential
 * holds one connects, for the user who owns the credential. The password is
 * read from that user's vault right then and never written anywhere.
 */

const REFERENCE = new RegExp(
  `^${SECRET_SCHEME}://\\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\}?/password/?$`,
  "i",
);

/**
 * How long one fetched vault answers. Connecting to several hosts at once
 * then costs one Dashlane request and one key derivation, and the passwords
 * live in memory only that long.
 */
const VAULT_TTL_MS = 30_000;

export class SecretReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretReferenceError";
  }
}

export interface ResolverDeps {
  ctx: PluginContext;
  repo: Repository;
  fetchVault: (key: DeviceKey) => Promise<Vault>;
  now?: () => number;
}

export function createSecretResolver({
  ctx,
  repo,
  fetchVault,
  now = Date.now,
}: ResolverDeps) {
  const cache = new Map<
    string,
    { expiresAt: number; passwords: Promise<Map<string, string>> }
  >();

  /** The passwords of the logins in the user's chosen collections, by id. */
  async function loadPasswords(userId: string): Promise<Map<string, string>> {
    const connection = await repo.getConnection(userId);
    if (!connection) {
      throw new SecretReferenceError("Dashlane is not connected for this user");
    }
    const raw = await ctx.asUser(userId, () =>
      ctx.secrets.get(DEVICE_KEY_SECRET),
    );
    if (!raw) {
      throw new SecretReferenceError("Dashlane is not connected for this user");
    }
    const vault = await fetchVault(parseDeviceKey(raw));
    const passwords = new Map<string, string>();
    for (const [id, { credential }] of selectCredentials(
      vault,
      connection.collections,
    )) {
      if (credential.password) passwords.set(id, credential.password);
    }
    return passwords;
  }

  function passwordsFor(userId: string): Promise<Map<string, string>> {
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > now()) return hit.passwords;
    const passwords = loadPasswords(userId);
    cache.set(userId, { expiresAt: now() + VAULT_TTL_MS, passwords });
    // A failure is not remembered, so the next connect tries again.
    passwords.catch(() => {
      if (cache.get(userId)?.passwords === passwords) cache.delete(userId);
    });
    return passwords;
  }

  return {
    async resolve(userId: string, reference: string): Promise<string> {
      const match = REFERENCE.exec(reference.trim());
      if (!match) {
        throw new SecretReferenceError(
          `Not a Dashlane reference. Use ${SECRET_SCHEME}://<Dashlane id>/password`,
        );
      }
      const id = normalizeId(match[1]!);
      const password = (await passwordsFor(userId)).get(id);
      if (!password) {
        throw new SecretReferenceError(
          `Dashlane login ${id} is not in a collection you import, or has no password`,
        );
      }
      return password;
    },

    /** Drops what is held for a user, like when they disconnect. */
    forget(userId: string): void {
      cache.delete(userId);
    },
  };
}

export type SecretResolver = ReturnType<typeof createSecretResolver>;

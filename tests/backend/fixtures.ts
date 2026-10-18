import crypto from "node:crypto";
import zlib from "node:zlib";
import { argon2d } from "hash-wasm";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";

/**
 * Builds vaults the way Dashlane clients write them, so the plugin's real
 * decryption runs in tests: deflated XML behind a 6 byte header, encrypted
 * as a "$1$..." flexible payload.
 */

export const MASTER_PASSWORD = "correct horse battery staple";
export const LOGIN = "someone@example.com";

export type Derivation =
  | { algo: "pbkdf2"; iterations?: number }
  | { algo: "argon2d"; tCost?: number; mCost?: number; parallelism?: number };

export async function encryptPayload(
  plain: Buffer,
  password: string,
  derivation: Derivation = { algo: "pbkdf2", iterations: 10 },
  salt: Buffer = Buffer.alloc(16, 7),
): Promise<string> {
  let header: string;
  let key: Buffer;
  if (derivation.algo === "pbkdf2") {
    const iterations = derivation.iterations ?? 10;
    header = `$1$pbkdf2$${salt.length}$${iterations}$sha256$aes256$cbchmac$16$`;
    key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  } else {
    const tCost = derivation.tCost ?? 1;
    const mCost = derivation.mCost ?? 64;
    const parallelism = derivation.parallelism ?? 1;
    header = `$1$argon2d$${salt.length}$${tCost}$${mCost}$${parallelism}$aes256$cbchmac$16$`;
    key = Buffer.from(
      await argon2d({
        password,
        salt,
        iterations: tCost,
        memorySize: mCost,
        parallelism,
        hashLength: 32,
        outputType: "binary",
      }),
    );
  }
  const combined = crypto.createHash("sha512").update(key).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    combined.subarray(0, 32),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const hmac = crypto
    .createHmac("sha256", combined.subarray(32))
    .update(Buffer.concat([iv, ciphertext]))
    .digest();
  return Buffer.concat([
    Buffer.from(header, "latin1"),
    salt,
    iv,
    hmac,
    ciphertext,
  ]).toString("base64");
}

export function packXml(xml: string): Buffer {
  return Buffer.concat([
    Buffer.alloc(6),
    zlib.deflateRawSync(Buffer.from(xml, "utf8")),
  ]);
}

const cdata = (value: string) => `<![CDATA[${value}]]>`;

export function credentialXml(item: {
  id: string;
  title?: string;
  login?: string;
  email?: string;
  password?: string;
  url?: string;
}): string {
  const fields = Object.entries({
    Id: item.id,
    Title: item.title ?? "",
    Login: item.login ?? "",
    Email: item.email ?? "",
    Password: item.password ?? "",
    Url: item.url ?? "",
    Note: "",
  })
    .map(
      ([key, value]) => `<KWDataItem key="${key}">${cdata(value)}</KWDataItem>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><root><KWAuthentifiant>${fields}</KWAuthentifiant></root>`;
}

export function collectionXml(collection: {
  id: string;
  name: string;
  itemIds: string[];
  spaceId?: string;
}): string {
  const members = collection.itemIds
    .map(
      (id) =>
        `<KWCollectionVaultItem><KWDataItem key="Id">${cdata(id)}</KWDataItem>` +
        `<KWDataItem key="Type">${cdata("KWAuthentifiant")}</KWDataItem></KWCollectionVaultItem>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><root><KWCollection>` +
    `<KWDataItem key="Id">${cdata(collection.id)}</KWDataItem>` +
    `<KWDataItem key="Name">${cdata(collection.name)}</KWDataItem>` +
    `<KWDataItem key="SpaceId">${cdata(collection.spaceId ?? "")}</KWDataItem>` +
    `<KWDataList key="VaultItems">${members}</KWDataList>` +
    `</KWCollection></root>`
  );
}

export function deviceKeyFor(
  login = LOGIN,
  masterPassword = MASTER_PASSWORD,
  accessKey = "ACCESSKEY123",
): string {
  const payload = Buffer.from(
    JSON.stringify({ login, deviceSecretKey: "device-secret", masterPassword }),
  ).toString("base64");
  return `dls_${accessKey}_${payload}`;
}

export interface FakeVaultItem {
  type: string;
  identifier: string;
  xml?: string;
  action?: "BACKUP_EDIT" | "BACKUP_REMOVE";
  /** Encrypt with this password instead, to make the item undecryptable. */
  password?: string;
}

interface StoredCredential {
  id: number;
  userId: string;
  name: string;
  description: string;
  folder: string;
  tags: string[];
  username: string;
  password: string;
  authType: string;
}

/**
 * Fakes the two services the plugin talks to through ctx.fetch: Dashlane's
 * sync API and Termix core's /credentials routes.
 */
export function createFakeServers() {
  const vault: FakeVaultItem[] = [];
  const credentials = new Map<number, StoredCredential>();
  const requests: Array<{ url: string; init?: PluginFetchInit }> = [];
  let nextId = 1;
  let dashlaneFailure: {
    status: number;
    code: string;
    message: string;
  } | null = null;
  let coreFailure: { method: string; status: number } | null = null;
  let tokenOwner: (token: string) => string | undefined = () => undefined;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  async function dashlane(init?: PluginFetchInit): Promise<Response> {
    const auth = init?.headers?.Authorization ?? "";
    if (
      !auth.startsWith("DL1-HMAC-SHA256 ") ||
      !auth.includes(`Login=${LOGIN}`)
    ) {
      return json(401, {
        errors: [{ code: "invalid_authentication", message: "bad auth" }],
      });
    }
    if (dashlaneFailure) {
      return json(dashlaneFailure.status, {
        errors: [
          { code: dashlaneFailure.code, message: dashlaneFailure.message },
        ],
      });
    }
    const transactions = await Promise.all(
      vault.map(async (item) => ({
        identifier: item.identifier,
        type: item.type,
        action: item.action ?? "BACKUP_EDIT",
        content:
          item.action === "BACKUP_REMOVE" || !item.xml
            ? ""
            : await encryptPayload(
                packXml(item.xml),
                item.password ?? MASTER_PASSWORD,
              ),
      })),
    );
    return json(200, { data: { transactions, timestamp: 1, summary: {} } });
  }

  function core(url: URL, init?: PluginFetchInit): Response {
    const method = init?.method ?? "GET";
    const bearer = (init?.headers?.authorization ?? "").replace(/^Bearer /, "");
    const userId = tokenOwner(bearer);
    if (!userId) return json(401, { error: "Missing authentication token" });
    if (coreFailure && coreFailure.method === method) {
      return json(coreFailure.status, { error: "refused" });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    const match = url.pathname.match(/^\/credentials(?:\/(\d+))?$/);
    if (!match) return json(404, { error: "not found" });
    const id = match[1] ? Number(match[1]) : null;
    if (method === "POST" && id === null) {
      if (!body.name || (body.authType === "password" && !body.password)) {
        return json(400, { error: "Password is required" });
      }
      const created = { id: nextId++, userId, ...body };
      credentials.set(created.id, created);
      return json(201, { id: created.id, name: created.name });
    }
    const existing = id !== null ? credentials.get(id) : undefined;
    if (!existing || existing.userId !== userId) {
      return json(404, { error: "Credential not found" });
    }
    if (method === "PUT") {
      Object.assign(existing, body);
      return json(200, { id: existing.id });
    }
    if (method === "DELETE") {
      credentials.delete(existing.id);
      return json(200, { message: "Credential deleted successfully" });
    }
    return json(405, { error: "method" });
  }

  const fetch = async (
    url: string,
    init?: PluginFetchInit,
  ): Promise<Response> => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.hostname === "api.dashlane.com") {
      if (parsed.pathname !== "/v1/sync/GetLatestContent") return json(404, {});
      return dashlane(init);
    }
    if (parsed.hostname === "127.0.0.1" && parsed.port === "30001") {
      if (!init?.allowPrivateHosts?.includes("127.0.0.1")) {
        throw new Error("blocked private address");
      }
      return core(parsed, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  return {
    fetch,
    vault,
    credentials,
    requests,
    /** Says which user a token minted by ctx.auth.issueUserToken acts as. */
    resolveTokens(resolve: (token: string) => string | undefined) {
      tokenOwner = resolve;
    },
    failDashlane(failure: typeof dashlaneFailure) {
      dashlaneFailure = failure;
    },
    failCore(failure: typeof coreFailure) {
      coreFailure = failure;
    },
    credentialsOf(userId: string) {
      return [...credentials.values()].filter((c) => c.userId === userId);
    },
  };
}

export type FakeServers = ReturnType<typeof createFakeServers>;

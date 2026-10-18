import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import {
  LOGIN,
  collectionXml,
  createFakeServers,
  credentialXml,
  deviceKeyFor,
  type FakeServers,
} from "./fixtures.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

const WEB = "{11111111-AAAA-4AAA-8AAA-111111111111}";
const DB = "{22222222-BBBB-4BBB-8BBB-222222222222}";
const MAIL = "{33333333-CCCC-4CCC-8CCC-333333333333}";
const NOPASS = "{44444444-DDDD-4DDD-8DDD-444444444444}";
const SERVERS = "{AAAAAAAA-0000-4000-8000-000000000001}";
const PERSONAL = "{AAAAAAAA-0000-4000-8000-000000000002}";

let db: TestDb;
let mock: MockPluginContext;
let servers: FakeServers;
let server: http.Server;
let port: number;
let actor = "user-1";

function seedVault() {
  servers.vault.length = 0;
  servers.vault.push(
    {
      type: "AUTHENTIFIANT",
      identifier: WEB,
      xml: credentialXml({
        id: WEB,
        title: "web-1",
        login: "deploy",
        password: "pw-web",
        url: "https://web-1.example.com",
      }),
    },
    {
      type: "AUTHENTIFIANT",
      identifier: DB,
      xml: credentialXml({
        id: DB,
        title: "db-1",
        email: "dba@example.com",
        password: "pw-db",
      }),
    },
    {
      type: "AUTHENTIFIANT",
      identifier: MAIL,
      xml: credentialXml({
        id: MAIL,
        title: "mail",
        login: "me",
        password: "pw-mail",
      }),
    },
    {
      type: "AUTHENTIFIANT",
      identifier: NOPASS,
      xml: credentialXml({ id: NOPASS, title: "sso-only", login: "me" }),
    },
    {
      type: "COLLECTION",
      identifier: SERVERS,
      xml: collectionXml({
        id: SERVERS,
        name: "Servers",
        itemIds: [WEB, DB, NOPASS],
      }),
    },
    {
      type: "COLLECTION",
      identifier: PERSONAL,
      xml: collectionXml({ id: PERSONAL, name: "Personal", itemIds: [MAIL] }),
    },
  );
}

async function start(permissions: string[] = ["dashlane-secrets.use"]) {
  db = await createTestDb(pluginDir);
  for (const id of ["user-1", "user-2"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(id, id);
  }
  servers = createFakeServers();
  seedVault();

  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions,
    fetch: servers.fetch,
  });
  servers.resolveTokens((token) => {
    const index = Number(token.replace("fake-token-", "")) - 1;
    return mock.auth.userTokens[index]?.userId;
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor(actor);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

beforeEach(() => {
  actor = "user-1";
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function connectAndChoose(collections: string[], removeMissing = true) {
  const connected = await request("POST", "/connect", {
    deviceKey: deviceKeyFor(),
  });
  expect(connected.status).toBe(200);
  const config = await request("PUT", "/config", {
    collections,
    removeMissing,
  });
  expect(config.status).toBe(200);
  return config.body;
}

describe("connecting", () => {
  beforeEach(() => start());

  it("starts disconnected", async () => {
    expect((await request("GET", "/status")).body).toEqual({
      connected: false,
      syncIntervalMinutes: 60,
    });
  });

  it("checks the key against Dashlane, stores it and lists the collections", async () => {
    const res = await request("POST", "/connect", {
      deviceKey: deviceKeyFor(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      login: LOGIN,
      collections: [],
      availableCollections: [
        { name: "Personal", items: 1 },
        { name: "Servers", items: 3 },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain("dls_");
    expect(await mock.ctx.secrets.get("deviceKey")).toBe(deviceKeyFor());
  });

  it("signs the Dashlane request with the device keys", async () => {
    await request("POST", "/connect", { deviceKey: deviceKeyFor() });
    const call = servers.requests.find((r) =>
      r.url.includes("api.dashlane.com"),
    )!;
    expect(call.url).toBe("https://api.dashlane.com/v1/sync/GetLatestContent");
    expect(call.init?.headers?.Authorization).toMatch(
      /^DL1-HMAC-SHA256 Login=someone@example\.com,AppAccessKey=\w+,DeviceAccessKey=ACCESSKEY123,Timestamp=\d+,SignedHeaders=content-type;user-agent,Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.parse(call.init!.body!)).toEqual({
      timestamp: 0,
      needsKeys: false,
      teamAdminGroups: false,
      transactions: [],
    });
  });

  it("refuses something that is not a device key", async () => {
    const res = await request("POST", "/connect", { deviceKey: "hunter2" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_key");
    expect(await mock.ctx.secrets.get("deviceKey")).toBeNull();
  });

  it("reports what Dashlane said when it refuses the key", async () => {
    servers.failDashlane({
      status: 403,
      code: "device_deactivated",
      message: "Device deactivated",
    });
    const res = await request("POST", "/connect", {
      deviceKey: deviceKeyFor(),
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "Device deactivated",
      code: "device_deactivated",
    });
    expect((await request("GET", "/status")).body.connected).toBe(false);
  });

  it("says when the master password in the key no longer decrypts the vault", async () => {
    const res = await request("POST", "/connect", {
      deviceKey: deviceKeyFor(LOGIN, "an old master password"),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("decrypt_failed");
  });

  it("validates the collection list", async () => {
    await request("POST", "/connect", { deviceKey: deviceKeyFor() });
    expect(
      (await request("PUT", "/config", { collections: "Servers" })).status,
    ).toBe(400);
    expect(
      (await request("PUT", "/config", { collections: [""] })).status,
    ).toBe(400);
    expect(
      (
        await request("PUT", "/config", {
          collections: ["a"],
          removeMissing: "yes",
        })
      ).status,
    ).toBe(400);
  });

  it("needs a connection before collections can be chosen", async () => {
    const res = await request("PUT", "/config", { collections: ["Servers"] });
    expect(res.status).toBe(404);
  });

  it("keeps each user's connection to themselves", async () => {
    await connectAndChoose(["Servers"]);
    actor = "user-2";
    expect((await request("GET", "/status")).body.connected).toBe(false);
    expect((await request("POST", "/sync")).status).toBe(404);
  });
});

describe("syncing", () => {
  beforeEach(() => start());

  it("imports the logins of the chosen collections as password credentials", async () => {
    await connectAndChoose(["Servers"]);
    const res = await request("POST", "/sync");
    expect(res.status).toBe(200);
    expect(res.body.lastStatus).toBe("ok");
    expect(res.body.lastSummary).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 1,
    });
    const stored = servers
      .credentialsOf("user-1")
      .map(({ id: _id, userId: _u, ...rest }) => rest);
    expect(stored).toEqual([
      {
        name: "web-1",
        description: "https://web-1.example.com",
        folder: "Servers",
        tags: ["dashlane", "dashlane:11111111-AAAA-4AAA-8AAA-111111111111"],
        username: "deploy",
        password: "pw-web",
        authType: "password",
      },
      {
        name: "db-1",
        description: "",
        folder: "Servers",
        tags: ["dashlane", "dashlane:22222222-BBBB-4BBB-8BBB-222222222222"],
        username: "dba@example.com",
        password: "pw-db",
        authType: "password",
      },
    ]);
    expect(
      res.body.items.map((i: { title: string; tag: string }) => [
        i.title,
        i.tag,
      ]),
    ).toEqual([
      ["db-1", "dashlane:22222222-BBBB-4BBB-8BBB-222222222222"],
      ["web-1", "dashlane:11111111-AAAA-4AAA-8AAA-111111111111"],
    ]);
    expect(mock.auth.userTokens).toEqual([
      expect.objectContaining({ userId: "user-1", purpose: "Dashlane sync" }),
    ]);
  });

  it("matches collection names without caring about case", async () => {
    await connectAndChoose(["servers"]);
    expect((await request("POST", "/sync")).body.lastSummary.created).toBe(2);
  });

  it("leaves unchanged logins alone and asks Termix for nothing", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    const before = servers.requests.length;
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
    });
    const coreCalls = servers.requests
      .slice(before)
      .filter((r) => r.url.includes("127.0.0.1"));
    expect(coreCalls).toEqual([]);
    expect(mock.auth.userTokens).toHaveLength(1);
  });

  it("updates a credential when its login changes in Dashlane", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    servers.vault[0].xml = credentialXml({
      id: WEB,
      title: "web-1",
      login: "deploy",
      password: "rotated",
    });
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary).toMatchObject({ updated: 1, unchanged: 1 });
    expect(
      servers.credentialsOf("user-1").find((c) => c.name === "web-1")?.password,
    ).toBe("rotated");
  });

  it("makes a credential again when it was deleted in Termix", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    const web = servers
      .credentialsOf("user-1")
      .find((c) => c.name === "web-1")!;
    servers.credentials.delete(web.id);
    servers.vault[0].xml = credentialXml({
      id: WEB,
      title: "web-1",
      password: "rotated",
    });
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary).toMatchObject({ created: 1, updated: 0 });
    expect(servers.credentialsOf("user-1")).toHaveLength(2);
    const again = servers
      .credentialsOf("user-1")
      .find((c) => c.name === "web-1")!;
    // A new Termix id, but the same tag, so whatever found it by tag still does.
    expect(again.id).not.toBe(web.id);
    expect(again.tags).toEqual(web.tags);
  });

  it("deletes credentials whose login left the chosen collections", async () => {
    await connectAndChoose(["Servers", "Personal"]);
    await request("POST", "/sync");
    expect(servers.credentialsOf("user-1")).toHaveLength(3);

    await request("PUT", "/config", {
      collections: ["Servers"],
      removeMissing: true,
    });
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary).toMatchObject({ removed: 1, unchanged: 2 });
    expect(
      servers
        .credentialsOf("user-1")
        .map((c) => c.name)
        .sort(),
    ).toEqual(["db-1", "web-1"]);
  });

  it("keeps them, untracked, when removal is off", async () => {
    await connectAndChoose(["Servers", "Personal"], false);
    await request("POST", "/sync");
    await request("PUT", "/config", { collections: ["Servers"] });
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary.removed).toBe(0);
    expect(servers.credentialsOf("user-1")).toHaveLength(3);
    expect(res.body.items).toHaveLength(2);
  });

  it("files a login in several collections under the first one chosen", async () => {
    servers.vault[5].xml = collectionXml({
      id: PERSONAL,
      name: "Personal",
      itemIds: [MAIL, WEB],
    });
    await connectAndChoose(["Personal", "Servers"]);
    await request("POST", "/sync");
    expect(
      servers.credentialsOf("user-1").find((c) => c.name === "web-1")?.folder,
    ).toBe("Personal");
  });

  it("removes nothing when part of the vault could not be decrypted", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    servers.vault[1].password = "something else";
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary.removed).toBe(0);
    expect(servers.credentialsOf("user-1")).toHaveLength(2);
  });

  it("keeps credentials of a chosen collection that vanished from the vault", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    servers.vault.splice(4, 1);
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary.removed).toBe(0);
    expect(servers.credentialsOf("user-1")).toHaveLength(2);

    await request("PUT", "/config", { collections: [] });
    expect((await request("POST", "/sync")).body.lastSummary.removed).toBe(2);
  });

  it("records a failed sync and shows why", async () => {
    await connectAndChoose(["Servers"]);
    servers.failCore({ method: "POST", status: 403 });
    const res = await request("POST", "/sync");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(
      /Termix refused to create a credential \(403/,
    );
    const status = (await request("GET", "/status")).body;
    expect(status.lastStatus).toBe("error");
    expect(status.lastError).toMatch(/403/);
  });

  it("refreshes the collection list from the vault", async () => {
    await connectAndChoose([]);
    servers.vault.push({
      type: "COLLECTION",
      identifier: "{AAAAAAAA-0000-4000-8000-000000000003}",
      xml: collectionXml({
        id: "{AAAAAAAA-0000-4000-8000-000000000003}",
        name: "Lab",
        itemIds: [],
      }),
    });
    const res = await request("POST", "/collections/refresh");
    expect(
      res.body.availableCollections.map((c: { name: string }) => c.name),
    ).toEqual(["Lab", "Personal", "Servers"]);
  });
});

describe("disconnecting", () => {
  beforeEach(() => start());

  it("forgets the key and keeps imported credentials by default", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    expect((await request("DELETE", "/connect")).body).toEqual({
      connected: false,
    });
    expect(await mock.ctx.secrets.get("deviceKey")).toBeNull();
    expect(servers.credentialsOf("user-1")).toHaveLength(2);
    expect((await request("GET", "/status")).body.connected).toBe(false);
  });

  it("can delete the imported credentials too", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    await request("DELETE", "/connect?removeCredentials=true");
    expect(servers.credentialsOf("user-1")).toEqual([]);
  });
});

describe("password references", () => {
  beforeEach(() => start());

  const resolve = (userId: string, reference: string) =>
    mock.auth.secretResolvers.get("dashlane")!(userId, reference);
  const vaultFetches = () =>
    servers.requests.filter((r) => r.url.includes("GetLatestContent")).length;

  async function connectWithReferences() {
    await connectAndChoose(["Servers"]);
    const saved = await request("PUT", "/config", {
      collections: ["Servers"],
      passwordReferences: true,
    });
    expect(saved.body.passwordReferences).toBe(true);
  }

  it("stores references instead of passwords", async () => {
    await connectWithReferences();
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary).toMatchObject({ created: 2 });
    expect(
      servers.credentialsOf("user-1").map((c) => [c.name, c.password]),
    ).toEqual([
      ["web-1", "dashlane://11111111-AAAA-4AAA-8AAA-111111111111/password"],
      ["db-1", "dashlane://22222222-BBBB-4BBB-8BBB-222222222222/password"],
    ]);
    expect(JSON.stringify(servers.credentialsOf("user-1"))).not.toContain(
      "pw-",
    );
  });

  it("resolves a reference from the vault when a host connects", async () => {
    await connectWithReferences();
    await request("POST", "/sync");
    const before = vaultFetches();
    expect(
      await resolve(
        "user-1",
        "dashlane://11111111-AAAA-4AAA-8AAA-111111111111/password",
      ),
    ).toBe("pw-web");
    // Braces and any case, and the vault is fetched once for both.
    expect(
      await resolve(
        "user-1",
        "dashlane://{22222222-bbbb-4bbb-8bbb-222222222222}/password",
      ),
    ).toBe("pw-db");
    expect(vaultFetches() - before).toBe(1);
  });

  it("only resolves logins in the chosen collections, for a connected user", async () => {
    await connectWithReferences();
    await expect(
      resolve(
        "user-1",
        "dashlane://33333333-CCCC-4CCC-8CCC-333333333333/password",
      ),
    ).rejects.toThrow(/not in a collection you import/);
    await expect(
      resolve("user-1", "dashlane://11111111-AAAA-4AAA-8AAA-111111111111/note"),
    ).rejects.toThrow(/Not a Dashlane reference/);
    await expect(
      resolve(
        "user-2",
        "dashlane://11111111-AAAA-4AAA-8AAA-111111111111/password",
      ),
    ).rejects.toThrow(/not connected/);

    await request("DELETE", "/connect");
    await expect(
      resolve(
        "user-1",
        "dashlane://11111111-AAAA-4AAA-8AAA-111111111111/password",
      ),
    ).rejects.toThrow(/not connected/);
  });

  it("writes the passwords back when turned off", async () => {
    await connectWithReferences();
    await request("POST", "/sync");
    await request("PUT", "/config", {
      collections: ["Servers"],
      passwordReferences: false,
    });
    const res = await request("POST", "/sync");
    expect(res.body.lastSummary).toMatchObject({ updated: 2, created: 0 });
    expect(servers.credentialsOf("user-1").map((c) => c.password)).toEqual([
      "pw-web",
      "pw-db",
    ]);
  });

  it("refuses a value that is not true or false", async () => {
    await connectAndChoose(["Servers"]);
    const res = await request("PUT", "/config", {
      collections: ["Servers"],
      passwordReferences: "yes",
    });
    expect(res.status).toBe(400);
  });
});

describe("scheduled sync", () => {
  beforeEach(() => start());

  it("syncs connections that are due, as their own user", async () => {
    await connectAndChoose(["Servers"]);
    actor = "user-2";
    mock.setActor(undefined);
    expect(mock.scheduled).toEqual([
      expect.objectContaining({ kind: "every", ms: 60_000 }),
    ]);
    await mock.runScheduled();
    expect(servers.credentialsOf("user-1")).toHaveLength(2);
    expect(mock.auth.userTokens.map((t) => t.userId)).toEqual(["user-1"]);
  });

  it("waits for the interval before syncing again", async () => {
    await connectAndChoose(["Servers"]);
    await request("POST", "/sync");
    servers.vault[0].xml = credentialXml({
      id: WEB,
      title: "web-1",
      password: "rotated",
    });
    await mock.runScheduled();
    expect(
      servers.credentialsOf("user-1").find((c) => c.name === "web-1")?.password,
    ).toBe("pw-web");
  });

  it("does nothing when the admin turned automatic sync off", async () => {
    await connectAndChoose(["Servers"]);
    await mock.ctx.settings.set("syncIntervalMinutes", 0);
    await mock.runScheduled();
    expect(servers.credentialsOf("user-1")).toEqual([]);
  });

  it("skips connections with no collections chosen", async () => {
    await connectAndChoose([]);
    await mock.runScheduled();
    expect(mock.auth.userTokens).toEqual([]);
  });

  it("records a failure instead of throwing", async () => {
    await connectAndChoose(["Servers"]);
    servers.failDashlane({
      status: 500,
      code: "oops",
      message: "Dashlane is down",
    });
    await expect(mock.runScheduled()).resolves.toBeUndefined();
    const status = (await request("GET", "/status")).body;
    expect(status.lastStatus).toBe("error");
    expect(status.lastError).toBe("Dashlane is down");
  });
});

describe("lifecycle", () => {
  beforeEach(() => start());

  it("works after a disable and enable", async () => {
    await connectAndChoose(["Servers"]);
    for (const dispose of mock.disposals) await dispose();
    await activate(mock.ctx);
    expect((await request("GET", "/status")).body.login).toBe(LOGIN);
  });
});

describe("permissions", () => {
  beforeEach(() => start([]));

  it("refuses users without dashlane-secrets.use", async () => {
    expect((await request("GET", "/status")).status).toBe(403);
    expect(
      (await request("POST", "/connect", { deviceKey: deviceKeyFor() })).status,
    ).toBe(403);
  });
});

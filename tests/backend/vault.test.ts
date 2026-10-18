import { describe, expect, it } from "vitest";
import {
  buildVault,
  normalizeId,
  parseCollection,
  parseCredential,
} from "../../src/backend/dashlane/vault.js";
import { createDecryptor } from "../../src/backend/dashlane/crypto.js";
import {
  MASTER_PASSWORD,
  collectionXml,
  credentialXml,
  encryptPayload,
  packXml,
} from "./fixtures.js";

const A = "{11111111-AAAA-4AAA-8AAA-111111111111}";
const B = "{22222222-BBBB-4BBB-8BBB-222222222222}";
const C = "{33333333-CCCC-4CCC-8CCC-333333333333}";
const SPACE = "{99999999-9999-4999-8999-999999999999}";

describe("vault items", () => {
  it("reads a login", () => {
    expect(
      parseCredential(
        A,
        credentialXml({
          id: A,
          title: "db-1 & <prod>",
          login: "root",
          password: "p<a>ss]]x",
          url: "https://db-1.example.com",
        }),
      ),
    ).toEqual({
      id: normalizeId(A),
      title: "db-1 & <prod>",
      login: "root",
      email: "",
      secondaryLogin: "",
      password: "p<a>ss]]x",
      url: "https://db-1.example.com",
      note: "",
    });
  });

  it("reads a collection's name and members, not its own id or space", () => {
    const collection = parseCollection(
      C,
      collectionXml({
        id: C,
        name: "Servers",
        itemIds: [A, B],
        spaceId: SPACE,
      }),
    );
    expect(collection).toEqual({
      id: normalizeId(C),
      name: "Servers",
      itemIds: [normalizeId(A), normalizeId(B)],
    });
  });

  it("finds members whatever element they are written in", () => {
    const xml =
      `<root><KWCollection><KWDataItem key="Name"><![CDATA[Ops]]></KWDataItem>` +
      `<KWDataItem key="VaultItems"><![CDATA[${A},${B.toLowerCase()}]]></KWDataItem>` +
      `</KWCollection></root>`;
    expect(parseCollection(C, xml)?.itemIds).toEqual([
      normalizeId(A),
      normalizeId(B),
    ]);
  });

  it("skips a collection without a name", () => {
    expect(
      parseCollection(C, "<root><KWCollection></KWCollection></root>"),
    ).toBeNull();
  });

  it("builds the vault from transactions, honouring removals and counting failures", async () => {
    const enc = (xml: string, password = MASTER_PASSWORD) =>
      encryptPayload(packXml(xml), password);
    const vault = await buildVault(
      [
        {
          identifier: A,
          type: "AUTHENTIFIANT",
          action: "BACKUP_EDIT",
          content: await enc(credentialXml({ id: A, title: "old" })),
        },
        {
          identifier: A,
          type: "AUTHENTIFIANT",
          action: "BACKUP_EDIT",
          content: await enc(credentialXml({ id: A, title: "new" })),
        },
        {
          identifier: B,
          type: "AUTHENTIFIANT",
          action: "BACKUP_EDIT",
          content: await enc(credentialXml({ id: B })),
        },
        { identifier: B, type: "AUTHENTIFIANT", action: "BACKUP_REMOVE" },
        {
          identifier: C,
          type: "COLLECTION",
          action: "BACKUP_EDIT",
          content: await enc(
            collectionXml({ id: C, name: "Servers", itemIds: [A] }),
          ),
        },
        {
          identifier: "x",
          type: "SECURENOTE",
          action: "BACKUP_EDIT",
          content: "ignored",
        },
        {
          identifier: "y",
          type: "AUTHENTIFIANT",
          action: "BACKUP_EDIT",
          content: await enc(credentialXml({ id: "y" }), "other"),
        },
      ],
      createDecryptor(MASTER_PASSWORD),
    );
    expect(vault.credentials.map((c) => c.title)).toEqual(["new"]);
    expect(vault.collections.map((c) => c.name)).toEqual(["Servers"]);
    expect(vault.failed).toBe(1);
  });
});

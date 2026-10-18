import { XMLParser } from "fast-xml-parser";
import type { VaultTransaction } from "./api.js";
import { inflateTransaction } from "./crypto.js";

/** A Dashlane login ("AUTHENTIFIANT"), with the fields Termix can use. */
export interface VaultCredential {
  id: string;
  title: string;
  login: string;
  email: string;
  secondaryLogin: string;
  password: string;
  url: string;
  note: string;
}

export interface VaultCollection {
  id: string;
  name: string;
  /** Normalized ids of the items in the collection. */
  itemIds: string[];
}

export interface Vault {
  credentials: VaultCredential[];
  collections: VaultCollection[];
  /** Transactions that could not be decrypted or parsed. */
  failed: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => name === "KWDataItem" || name === "KWDataList",
});

const GUID =
  /\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/gi;

/** Dashlane writes ids as "{8A1B...}"; compare them without braces or case. */
export function normalizeId(id: string): string {
  return id.replace(/[{}]/g, "").trim().toUpperCase();
}

type XmlNode = Record<string, unknown>;

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const node = value as XmlNode;
    if (node["#cdata"] != null) return textOf(node["#cdata"]);
    if (node["#text"] != null) return textOf(node["#text"]);
  }
  return "";
}

/** The element under <root>, whatever the item type names it. */
function itemNode(xml: string): XmlNode | null {
  const doc = parser.parse(xml) as XmlNode;
  const root = doc.root as XmlNode | undefined;
  if (!root || typeof root !== "object") return null;
  const kind = Object.keys(root).find((key) => !key.startsWith("@_"));
  const node = kind ? root[kind] : null;
  return node && typeof node === "object" ? (node as XmlNode) : null;
}

/** The item's top level <KWDataItem key="...">, keyed in lower case. */
function fieldsOf(node: XmlNode): Map<string, string> {
  const fields = new Map<string, string>();
  for (const entry of (node.KWDataItem as XmlNode[] | undefined) ?? []) {
    const key = entry["@_key"];
    if (typeof key === "string") fields.set(key.toLowerCase(), textOf(entry));
  }
  return fields;
}

function collectGuids(value: unknown, into: Set<string>): void {
  if (value == null) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(GUID)) into.add(normalizeId(match[1]));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectGuids(entry, into);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as XmlNode)) {
      collectGuids(entry, into);
    }
  }
}

export function parseCredential(
  identifier: string,
  xml: string,
): VaultCredential | null {
  const node = itemNode(xml);
  if (!node) return null;
  const fields = fieldsOf(node);
  const get = (key: string) => fields.get(key.toLowerCase()) ?? "";
  return {
    id: normalizeId(get("Id") || identifier),
    title: get("Title"),
    login: get("Login"),
    email: get("Email"),
    secondaryLogin: get("SecondaryLogin"),
    password: get("Password"),
    url: get("Url") || get("UserSelectedUrl"),
    note: get("Note"),
  };
}

/**
 * Dashlane does not document how a collection is stored. It is a vault item
 * with a name and a list of the items in it, and the items are referenced by
 * their ids. So the name comes from the "Name" field and the members are every
 * item id written anywhere inside the collection, which holds whatever the
 * exact element names are.
 */
export function parseCollection(
  identifier: string,
  xml: string,
): VaultCollection | null {
  const node = itemNode(xml);
  if (!node) return null;
  const fields = fieldsOf(node);
  const id = normalizeId(fields.get("id") || identifier);
  const name = (fields.get("name") ?? "").trim();
  if (!name) return null;
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(node)) {
    if (key === "KWDataItem") {
      for (const entry of value as XmlNode[]) {
        const fieldKey = String(entry["@_key"] ?? "").toLowerCase();
        // Its own id, and the space it belongs to, are not members.
        if (fieldKey === "id" || fieldKey === "spaceid") continue;
        collectGuids(entry, ids);
      }
    } else if (!key.startsWith("@_")) {
      collectGuids(value, ids);
    }
  }
  ids.delete(id);
  return { id, name, itemIds: [...ids] };
}

function isCollectionType(type: string): boolean {
  return /COLLECTION/i.test(type);
}

/**
 * Builds the vault from GetLatestContent's transactions. A later transaction
 * for the same item replaces an earlier one, and BACKUP_REMOVE deletes it.
 */
export async function buildVault(
  transactions: VaultTransaction[],
  decrypt: (base64: string) => Promise<Buffer>,
): Promise<Vault> {
  const latest = new Map<string, VaultTransaction>();
  for (const transaction of transactions) {
    if (
      transaction.type !== "AUTHENTIFIANT" &&
      !isCollectionType(transaction.type)
    ) {
      continue;
    }
    latest.set(`${transaction.type}:${transaction.identifier}`, transaction);
  }

  const credentials: VaultCredential[] = [];
  const collections: VaultCollection[] = [];
  let failed = 0;
  for (const transaction of latest.values()) {
    if (transaction.action !== "BACKUP_EDIT" || !transaction.content) continue;
    try {
      const xml = inflateTransaction(await decrypt(transaction.content));
      if (transaction.type === "AUTHENTIFIANT") {
        const credential = parseCredential(transaction.identifier, xml);
        if (credential) credentials.push(credential);
      } else {
        const collection = parseCollection(transaction.identifier, xml);
        if (collection) collections.push(collection);
      }
    } catch {
      failed += 1;
    }
  }
  collections.sort((a, b) => a.name.localeCompare(b.name));
  return { credentials, collections, failed };
}

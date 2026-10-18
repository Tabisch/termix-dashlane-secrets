import {
  defineTable,
  id,
  integer,
  json,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/**
 * One row per user who connected Dashlane. The service device key itself is
 * not here: it lives in ctx.secrets, encrypted with the installation key, so
 * a scheduled sync can read it while the user is signed out.
 */
export const connections = defineTable("connections", {
  id: id(),
  userId: refUser().notNull().unique(),
  login: varchar(255).notNull(),
  /** Collection names to import, as the user picked them. */
  collections: json().notNull(),
  /** Every collection seen in the vault on the last fetch, for the picker. */
  availableCollections: json(),
  /** Delete credentials this plugin made when their item leaves the collections. */
  removeMissing: integer().notNull().default(1),
  lastSyncAt: timestamp(),
  /** "ok" or "error". */
  lastStatus: varchar(16),
  lastError: text(),
  /** Counts from the last run: created, updated, removed, skipped. */
  lastSummary: json(),
  createdAt: timestamp().notNull().defaultNow(),
});

/**
 * Which Termix credential a Dashlane item was imported as. contentHash is a
 * hash of what was last written, so an unchanged item is not written again.
 */
export const items = defineTable(
  "items",
  {
    id: id(),
    userId: refUser().notNull(),
    dashlaneId: varchar(64).notNull(),
    credentialId: integer().notNull(),
    collection: varchar(255).notNull(),
    title: text(),
    contentHash: varchar(64).notNull(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_p_dashlane_secrets_items_user_id", columns: ["userId"] },
    ],
    uniques: [
      {
        name: "uq_p_dashlane_secrets_items_user_item",
        columns: ["userId", "dashlaneId"],
      },
    ],
  },
);

// termix-plugin migrations reads this list.
export const tables = [connections, items];

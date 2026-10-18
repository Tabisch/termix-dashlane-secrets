import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

export interface CollectionInfo {
  name: string;
  items: number;
}

export interface SyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
}

export interface ImportedCredential {
  title: string | null;
  collection: string;
  credentialId: number;
  updatedAt: string;
}

export type Status =
  | { connected: false; syncIntervalMinutes: number }
  | {
      connected: true;
      syncIntervalMinutes: number;
      login: string;
      collections: string[];
      availableCollections: CollectionInfo[];
      removeMissing: boolean;
      lastSyncAt: string | null;
      lastStatus: "ok" | "error" | null;
      lastError: string | null;
      lastSummary: SyncSummary | null;
      items: ImportedCredential[];
    };

type Api = TermixApp["api"];

export function createDashlaneApi(api: Api) {
  return {
    status: async () => (await api.get<Status>("/status")).data,
    connect: async (deviceKey: string) =>
      (await api.post<Status>("/connect", { deviceKey })).data,
    saveConfig: async (collections: string[], removeMissing: boolean) =>
      (await api.put<Status>("/config", { collections, removeMissing })).data,
    refreshCollections: async () =>
      (await api.post<Status>("/collections/refresh")).data,
    sync: async () => (await api.post<Status>("/sync")).data,
    disconnect: async (removeCredentials: boolean) =>
      (
        await api.delete<Status>(
          `/connect${removeCredentials ? "?removeCredentials=true" : ""}`,
        )
      ).data,
  };
}

export type DashlaneApi = ReturnType<typeof createDashlaneApi>;

/** The server's own message when there is one, so people see what Dashlane said. */
export function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  return fallback;
}

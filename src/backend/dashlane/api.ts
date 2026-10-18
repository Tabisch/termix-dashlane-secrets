import { postRequestAPI } from "@dashlane/apiconnect-worker";
import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import type { DeviceKey } from "./device-key.js";

/**
 * The app keys Dashlane gave the Dashlane CLI. Service device keys are made
 * by `dcli devices register`, so they belong to that app, and requests signed
 * with them have to carry its keys. They are public in the CLI's source
 * (src/requestApi.ts) and are not a secret of this plugin.
 */
const DCLI_APP_KEYS = {
  appAccessKey: "HB9JQATDY6Y62JYKT7KXBN4C7FH8HKC5",
  appSecretKey:
    "boUtXxmDgLUtNFaigCMQ3+u+LAx0tg1ePAUE13nkR7dto+Zwq1naOHZTwbxxM7iL",
};

const USER_AGENT = "Termix Dashlane plugin";

export interface VaultTransaction {
  identifier: string;
  type: string;
  action: "BACKUP_EDIT" | "BACKUP_REMOVE" | string;
  /** Base64 encrypted payload, for BACKUP_EDIT. */
  content?: string;
}

export interface LatestContent {
  transactions: VaultTransaction[];
  timestamp: number;
}

export class DashlaneApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DashlaneApiError";
  }
}

async function requestUserApi<T>(
  fetch: PluginFetch,
  key: DeviceKey,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await postRequestAPI<Response>({
    path: `v1/${path}`,
    payload,
    userAgent: USER_AGENT,
    authentication: {
      type: "userDevice",
      login: key.login,
      accessKey: key.accessKey,
      secretKey: key.secretKey,
      ...DCLI_APP_KEYS,
    },
    requestFunction: async ({ method, url, json, headers }) => {
      // Host is not a signed header, and fetch sets it from the URL.
      const { host: _host, ...rest } = headers;
      return fetch(url, {
        method,
        headers: rest,
        // The signature covers JSON.stringify of this same object.
        body: JSON.stringify(json),
        timeoutMs: 60_000,
      });
    },
  });

  const body = await response.text();
  let parsed: { data?: T; errors?: { code?: string; message?: string }[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DashlaneApiError(
      `Dashlane answered ${response.status} with a body that is not JSON`,
      undefined,
      response.status,
    );
  }
  if (!response.ok || parsed.errors?.length) {
    const first = parsed.errors?.[0];
    throw new DashlaneApiError(
      first?.message || `Dashlane answered ${response.status}`,
      first?.code,
      response.status,
    );
  }
  return parsed.data as T;
}

/** Every transaction in the personal vault. Timestamp 0 means "from the start". */
export function getLatestContent(
  fetch: PluginFetch,
  key: DeviceKey,
): Promise<LatestContent> {
  return requestUserApi<LatestContent>(fetch, key, "sync/GetLatestContent", {
    timestamp: 0,
    needsKeys: false,
    teamAdminGroups: false,
    transactions: [],
  });
}

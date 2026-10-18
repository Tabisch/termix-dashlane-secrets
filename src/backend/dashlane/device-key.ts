/**
 * A Dashlane service device key, as printed by `dcli devices register <name>`:
 *
 *   dls_<deviceAccessKey>_<base64 JSON { login, deviceSecretKey, masterPassword }>
 *
 * It is what lets a server read a vault with no one at the keyboard: the
 * device keys sign API requests and the master password decrypts the vault.
 */
export interface DeviceKey {
  login: string;
  accessKey: string;
  secretKey: string;
  masterPassword: string;
}

export class DeviceKeyFormatError extends Error {
  constructor(message = "Not a Dashlane service device key (dls_...)") {
    super(message);
    this.name = "DeviceKeyFormatError";
  }
}

export function parseDeviceKey(raw: string): DeviceKey {
  const value = raw.trim().replace(/^DASHLANE_SERVICE_DEVICE_KEYS=/, "");
  if (!value.startsWith("dls_")) throw new DeviceKeyFormatError();
  const [, accessKey, payloadB64] = value.split("_");
  if (!accessKey || !payloadB64) throw new DeviceKeyFormatError();

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  } catch {
    throw new DeviceKeyFormatError();
  }
  const { login, deviceSecretKey, masterPassword } = (payload ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof login !== "string" ||
    typeof deviceSecretKey !== "string" ||
    typeof masterPassword !== "string" ||
    !login ||
    !deviceSecretKey
  ) {
    throw new DeviceKeyFormatError();
  }
  return { login, accessKey, secretKey: deviceSecretKey, masterPassword };
}

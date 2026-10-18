import crypto from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { argon2d } from "hash-wasm";

/**
 * Dashlane's "flexible" encrypted payload, as written by every Dashlane
 * client and read by the Dashlane CLI (Apache-2.0, github.com/Dashlane/dashlane-cli,
 * src/modules/crypto). The layout is an ASCII header followed by raw bytes:
 *
 *   $1$<derivation>$...$aes256$<cbchmac|cbchmac64>$<ivLength>$<salt><iv><hmac><ciphertext>
 *
 * where <derivation> is "argon2d$<saltLength>$<tCost>$<mCost>$<parallelism>",
 * "pbkdf2$<saltLength>$<iterations>$<hash>" or "noderivation".
 */

type DerivationConfig =
  | {
      algo: "argon2d";
      saltLength: number;
      tCost: number;
      mCost: number;
      parallelism: number;
    }
  | {
      algo: "pbkdf2";
      saltLength: number;
      iterations: number;
      hashMethod: string;
    }
  | { algo: "noderivation" };

export interface EncryptedPayload {
  derivation: DerivationConfig;
  cipherMode: "cbchmac" | "cbchmac64";
  salt: Buffer;
  iv: Buffer;
  hmac: Buffer;
  ciphertext: Buffer;
  /** The header and salt, which together decide the derived key. */
  derivationId: string;
}

const HMAC_LENGTH = 32;

export function parseEncryptedPayload(base64: string): EncryptedPayload {
  const bytes = Buffer.from(base64, "base64");
  // The header is ASCII. latin1 keeps one char per byte, so the char offset
  // of the end of the header is also its byte offset.
  const text = bytes.toString("latin1");
  let cursor = 0;
  const next = (): string => {
    const end = text.indexOf("$", cursor);
    if (end < 0) throw new Error("Invalid Dashlane payload: truncated header");
    const part = text.slice(cursor, end);
    cursor = end + 1;
    return part;
  };

  if (next() !== "") throw new Error("Invalid Dashlane payload: no marker");
  const version = next();
  if (version !== "1") {
    throw new Error(`Unsupported Dashlane payload version ${version}`);
  }

  let derivation: DerivationConfig;
  const algo = next();
  if (algo === "argon2d") {
    derivation = {
      algo,
      saltLength: Number(next()),
      tCost: Number(next()),
      mCost: Number(next()),
      parallelism: Number(next()),
    };
  } else if (algo === "pbkdf2") {
    derivation = {
      algo,
      saltLength: Number(next()),
      iterations: Number(next()),
      hashMethod: next(),
    };
  } else if (algo === "noderivation") {
    derivation = { algo };
  } else {
    throw new Error(`Unsupported Dashlane key derivation ${algo}`);
  }

  const encryption = next();
  if (encryption !== "aes256") {
    throw new Error(`Unsupported Dashlane cipher ${encryption}`);
  }
  const cipherMode = next();
  if (cipherMode !== "cbchmac" && cipherMode !== "cbchmac64") {
    throw new Error(`Unsupported Dashlane cipher mode ${cipherMode}`);
  }
  const ivLength = Number(next());

  const saltLength =
    derivation.algo === "noderivation" ? 0 : derivation.saltLength;
  let offset = cursor;
  const salt = bytes.subarray(offset, offset + saltLength);
  offset += saltLength;
  const derivationId = bytes.subarray(0, offset).toString("latin1");
  const iv = bytes.subarray(offset, offset + ivLength);
  offset += ivLength;
  const hmac = bytes.subarray(offset, offset + HMAC_LENGTH);
  offset += HMAC_LENGTH;
  const ciphertext = bytes.subarray(offset);

  return { derivation, cipherMode, salt, iv, hmac, ciphertext, derivationId };
}

const pbkdf2 = promisify(crypto.pbkdf2);

export async function deriveKey(
  masterPassword: string,
  payload: EncryptedPayload,
): Promise<Buffer> {
  const { derivation, salt } = payload;
  switch (derivation.algo) {
    case "argon2d": {
      const hash = await argon2d({
        password: masterPassword,
        salt,
        iterations: derivation.tCost,
        memorySize: derivation.mCost,
        parallelism: derivation.parallelism,
        hashLength: 32,
        outputType: "binary",
      });
      return Buffer.from(hash);
    }
    case "pbkdf2":
      return pbkdf2(
        masterPassword,
        salt,
        derivation.iterations,
        32,
        derivation.hashMethod,
      );
    case "noderivation":
      return Buffer.from(masterPassword, "base64");
  }
}

export function decryptWithKey(payload: EncryptedPayload, key: Buffer): Buffer {
  let combined: Buffer;
  if (payload.cipherMode === "cbchmac64") {
    if (key.length !== 64) {
      throw new Error(`Dashlane key must be 64 bytes, got ${key.length}`);
    }
    combined = key;
  } else {
    combined = crypto.createHash("sha512").update(key).digest();
  }
  const cipherKey = combined.subarray(0, 32);
  const macKey = combined.subarray(32);

  const expected = crypto
    .createHmac("sha256", macKey)
    .update(Buffer.concat([payload.iv, payload.ciphertext]))
    .digest();
  if (
    expected.length !== payload.hmac.length ||
    !crypto.timingSafeEqual(expected, payload.hmac)
  ) {
    throw new Error("Dashlane payload signature does not match");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    cipherKey,
    payload.iv,
  );
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

/**
 * Decrypts payloads with one master password, deriving each distinct key
 * once. Dashlane reuses a salt across many items, and argon2d is the slow
 * part, so one sync usually derives a single key.
 */
export function createDecryptor(masterPassword: string) {
  const keys = new Map<string, Promise<Buffer>>();
  return async (base64: string): Promise<Buffer> => {
    const payload = parseEncryptedPayload(base64);
    let key = keys.get(payload.derivationId);
    if (!key) {
      key = deriveKey(masterPassword, payload);
      keys.set(payload.derivationId, key);
    }
    return decryptWithKey(payload, await key);
  };
}

/** A decrypted vault transaction is 6 header bytes and then raw deflate XML. */
export function inflateTransaction(decrypted: Buffer): string {
  return zlib.inflateRawSync(decrypted.subarray(6)).toString("utf8");
}

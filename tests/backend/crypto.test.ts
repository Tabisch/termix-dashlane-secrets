import { describe, expect, it } from "vitest";
import {
  createDecryptor,
  deriveKey,
  inflateTransaction,
  parseEncryptedPayload,
} from "../../src/backend/dashlane/crypto.js";
import {
  DeviceKeyFormatError,
  parseDeviceKey,
} from "../../src/backend/dashlane/device-key.js";
import { deviceKeyFor, encryptPayload, packXml } from "./fixtures.js";

describe("Dashlane payloads", () => {
  it("reads the header of an argon2d payload", async () => {
    const encrypted = await encryptPayload(Buffer.from("hi"), "pw", {
      algo: "argon2d",
      tCost: 3,
      mCost: 64,
      parallelism: 2,
    });
    const payload = parseEncryptedPayload(encrypted);
    expect(payload.derivation).toEqual({
      algo: "argon2d",
      saltLength: 16,
      tCost: 3,
      mCost: 64,
      parallelism: 2,
    });
    expect(payload.cipherMode).toBe("cbchmac");
    expect(payload.iv).toHaveLength(16);
    expect(payload.hmac).toHaveLength(32);
    expect(payload.salt).toEqual(Buffer.alloc(16, 7));
  });

  it("derives argon2d keys the same way as the Dashlane CLI", async () => {
    // Expected value computed with @node-rs/argon2 hashRaw (algorithm 0,
    // version 0x13), the library the Dashlane CLI uses.
    const payload = parseEncryptedPayload(
      Buffer.concat([
        Buffer.from("$1$argon2d$32$3$32768$2$aes256$cbchmac$16$", "latin1"),
        Buffer.from("0123456789abcdef0123456789abcdef"),
        Buffer.alloc(48),
      ]).toString("base64"),
    );
    const key = await deriveKey("correct horse battery", payload);
    expect(key.toString("hex")).toBe(
      "c898a10679b0756f2f701cd4031f25616195eb1aae2974f411afda777290757b",
    );
  });

  it("decrypts pbkdf2 and argon2d payloads and inflates the XML", async () => {
    const decrypt = createDecryptor("secret");
    for (const derivation of [
      { algo: "pbkdf2", iterations: 5 } as const,
      { algo: "argon2d", mCost: 64 } as const,
    ]) {
      const encrypted = await encryptPayload(
        packXml("<root/>"),
        "secret",
        derivation,
      );
      expect(inflateTransaction(await decrypt(encrypted))).toBe("<root/>");
    }
  });

  it("refuses a payload decrypted with the wrong password", async () => {
    const encrypted = await encryptPayload(Buffer.from("x"), "right");
    await expect(createDecryptor("wrong")(encrypted)).rejects.toThrow(
      /signature/,
    );
  });

  it("refuses payloads it does not understand", () => {
    expect(() =>
      parseEncryptedPayload(Buffer.from("$2$x$").toString("base64")),
    ).toThrow(/version/);
    expect(() =>
      parseEncryptedPayload(Buffer.from("$1$scrypt$1$").toString("base64")),
    ).toThrow(/derivation/);
  });
});

describe("service device keys", () => {
  it("reads the login, device keys and master password", () => {
    expect(parseDeviceKey(deviceKeyFor("a@b.c", "mp", "ACC"))).toEqual({
      login: "a@b.c",
      accessKey: "ACC",
      secretKey: "device-secret",
      masterPassword: "mp",
    });
  });

  it("accepts the line dcli prints, with the variable name", () => {
    expect(
      parseDeviceKey(`DASHLANE_SERVICE_DEVICE_KEYS=${deviceKeyFor()}\n`).login,
    ).toBe("someone@example.com");
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "tmx_abc",
      "dls_only",
      "dls_a_bm90LWpzb24=",
      "dls_a_e30=",
    ]) {
      expect(() => parseDeviceKey(bad)).toThrow(DeviceKeyFormatError);
    }
  });
});

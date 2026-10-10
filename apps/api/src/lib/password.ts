import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = ((await deriveKey(password, salt, 64)) as Buffer).toString("hex");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [salt, originalHash] = storedHash.split(":");

  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(storedHash)) {
    return false;
  }

  const derived = (await deriveKey(password, salt, 64)) as Buffer;
  const original = Buffer.from(originalHash, "hex");

  if (derived.length !== original.length) {
    return false;
  }

  return timingSafeEqual(derived, original);
}

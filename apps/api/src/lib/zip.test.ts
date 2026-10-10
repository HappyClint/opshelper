import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { unzip, ZipError } from "./zip";

function zip(data: Buffer, options: { declared?: number; method?: number; encrypted?: boolean } = {}) {
  const filename = Buffer.from("SKILL.md");
  const method = options.method ?? 8;
  const compressed = method === 8 ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(options.encrypted ? 1 : 0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(options.encrypted ? 1 : 0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(options.declared ?? data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

test("unzip preserves stored, compressed and empty files", () => {
  for (const method of [0, 8]) {
    for (const data of [Buffer.from("skill contents"), Buffer.alloc(0)]) {
      assert.deepEqual(unzip(zip(data, { method }))[0].data, data);
    }
  }
});

test("unzip limits actual inflation even when the declared size lies", () => {
  assert.throws(() => unzip(zip(Buffer.alloc(64 * 1024), { declared: 1 }), {
    maxEntryBytes: 1024, maxTotalBytes: 1024,
  }), ZipError);
  assert.throws(() => unzip(zip(Buffer.from("larger"), { declared: 1, method: 0 })), /大小不一致/);
  assert.throws(() => unzip(zip(Buffer.from("small"), { declared: 100 })), /大小不一致/);
});

test("unzip rejects encryption, oversized totals and corrupt offsets", () => {
  assert.throws(() => unzip(zip(Buffer.from("secret"), { encrypted: true })), /加密/);
  assert.throws(() => unzip(zip(Buffer.alloc(20)), { maxTotalBytes: 10 }), /体积过大/);
  const damaged = zip(Buffer.from("small"));
  damaged.writeUInt32LE(damaged.length, damaged.length - 22 + 16);
  assert.throws(() => unzip(damaged), ZipError);
  assert.throws(() => unzip(Buffer.alloc(10)), ZipError);
});

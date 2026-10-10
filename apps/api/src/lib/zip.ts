import { inflateRawSync } from "node:zlib";

// 依赖无关的最小 ZIP 解包器（仅用于用户上传的技能包）。通过中央目录
// (Central Directory) 定位每个条目，再回到本地头读取实际数据偏移，
// 支持 stored(0) 与 deflate(8) 两种压缩方式。刻意不支持 ZIP64 / 加密，
// 遇到则明确报错而非静默出错。

export class ZipError extends Error {}

export interface ZipEntry {
  /** 归一化后的条目名（正斜杠、无前导斜杠）。目录以 "/" 结尾。 */
  name: string;
  isDirectory: boolean;
  /** 解压后的内容；目录为空 Buffer。 */
  data: Buffer;
}

export interface UnzipLimits {
  /** 最大条目数，防目录炸弹。 */
  maxEntries?: number;
  /** 解压后总字节上限，防 zip 炸弹。 */
  maxTotalBytes?: number;
  /** 单条目解压后字节上限。 */
  maxEntryBytes?: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

function findEocd(buf: Buffer): number {
  // EOCD 记录至少 22 字节，注释最长 0xffff。从尾部向前扫描签名。
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new ZipError("不是有效的 ZIP 文件");
}

export function unzip(buf: Buffer, limits: UnzipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 2000;
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
  const maxEntryBytes = limits.maxEntryBytes ?? 32 * 1024 * 1024;

  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_MARKER || cdSize === ZIP64_MARKER || entryCount === 0xffff) {
    throw new ZipError("不支持 ZIP64 格式的技能包");
  }
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 ||
      buf.readUInt16LE(eocd + 8) !== entryCount || cdOffset + cdSize !== eocd) {
    throw new ZipError("不支持分卷 ZIP 或损坏的中央目录");
  }
  if (entryCount > maxEntries) {
    throw new ZipError(`ZIP 条目过多（${entryCount}），上限 ${maxEntries}`);
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CD_SIG) {
      throw new ZipError("ZIP 中央目录损坏");
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > eocd) {
      throw new ZipError("ZIP 中央目录损坏");
    }
    if ((buf.readUInt16LE(p + 8) & 1) !== 0 || buf.readUInt16LE(p + 34) !== 0) {
      throw new ZipError("不支持加密或分卷 ZIP");
    }
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (
      compSize === ZIP64_MARKER ||
      uncompSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      throw new ZipError("不支持 ZIP64 格式的技能包");
    }

    const name = rawName.replace(/\\/g, "/");
    if (!name || names.has(name)) throw new ZipError("ZIP 含空名称或重复路径");
    names.add(name);
    if (name.endsWith("/")) {
      entries.push({ name, isDirectory: true, data: Buffer.alloc(0) });
      continue;
    }

    if (uncompSize > maxEntryBytes) {
      throw new ZipError(`技能包内文件过大：${name}`);
    }
    if (total + uncompSize > maxTotalBytes) {
      throw new ZipError("技能包解压后体积过大");
    }

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL_SIG ||
        (buf.readUInt16LE(localOffset + 6) & 1) !== 0 || buf.readUInt16LE(localOffset + 8) !== method) {
      throw new ZipError("ZIP 本地头损坏");
    }
    // 本地头的文件名/扩展字段长度可能与中央目录不同，必须以本地头为准。
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > cdOffset) throw new ZipError("ZIP 文件数据不完整");
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      if (compSize !== uncompSize) throw new ZipError(`ZIP 文件大小不一致：${name}`);
      data = Buffer.from(comp);
    } else if (method === 8) {
      try {
        data = inflateRawSync(comp, {
          maxOutputLength: Math.max(1, Math.min(maxEntryBytes, maxTotalBytes - total, uncompSize)),
        });
      } catch {
        throw new ZipError(`解压失败：${name}`);
      }
    } else {
      throw new ZipError(`不支持的压缩方式（${method}）：${name}`);
    }

    if (data.length !== uncompSize) throw new ZipError(`ZIP 文件大小不一致：${name}`);
    total += data.length;

    entries.push({ name, isDirectory: false, data });
  }
  if (p !== eocd) throw new ZipError("ZIP 中央目录大小不一致");

  return entries;
}

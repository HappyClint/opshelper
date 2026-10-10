import assert from "node:assert/strict";
import test from "node:test";

import { importSkillPackage } from "./skill-package";

function storedZip(files: Record<string, Buffer | string>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = typeof value === "string" ? Buffer.from(value) : value;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    local.push(localHeader, filename, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, filename);
    offset += localHeader.length + filename.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

test("Skill ZIP strips its wrapper, preserves assets, and separates binary files", () => {
  const result = importSkillPackage(storedZip({
    "diagnose/SKILL.md": "---\nname: diagnose\ndescription: Diagnose systems\n---\nUse evidence.\n",
    "diagnose/references/checklist.md": "# Checklist\n",
    "diagnose/assets/icon.png": Buffer.from([0, 1, 2, 3]),
  }));
  assert.equal(result.skillName, "diagnose");
  assert.match(result.files["skills/diagnose/SKILL.md"], /name: diagnose/);
  assert.equal(result.files["skills/diagnose/references/checklist.md"], "# Checklist\n");
  assert.equal(result.binaryFiles["skills/diagnose/assets/icon.png"], Buffer.from([0, 1, 2, 3]).toString("base64"));
});

test("Skill ZIP rejects traversal and multiple skill roots", () => {
  assert.throws(() => importSkillPackage(storedZip({
    "../SKILL.md": "---\nname: bad\ndescription: Bad\n---\nBad\n",
  })), /不安全/);
  assert.throws(() => importSkillPackage(storedZip({
    "one/SKILL.md": "---\nname: one\ndescription: One\n---\nOne\n",
    "two/SKILL.md": "---\nname: two\ndescription: Two\n---\nTwo\n",
  })), /只能包含一个/);
});


test("Skill ZIP rejects duplicate paths after slash normalization", () => {
  assert.throws(() => importSkillPackage(storedZip({
    "SKILL.md": "---\nname: test-skill\ndescription: Test\n---\nTest\n",
    "assets\\file.txt": "first",
    "assets/file.txt": "second",
  })), /重复路径/);
});

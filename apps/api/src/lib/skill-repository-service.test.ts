import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSkillRepositorySkillFromZip,
  deleteSkillRepositorySkill,
  getSkillRepositorySkillPackage,
  listSkillRepositorySkills,
} from "./skill-repository-service";

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

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "opshelper-skill-repository-"));
process.env.DATA_ROOT = dataRoot;

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("列出技能仓库条目并读取技能内容", async () => {
  const skillDirectory = path.join(dataRoot, "skill-repository", "diagnose");
  await mkdir(path.join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    "---\nname: diagnose\ndescription: Diagnose systems\n---\nUse evidence.\n",
  );
  await writeFile(path.join(skillDirectory, "references", "checklist.md"), "# Checklist\n");
  await writeFile(path.join(skillDirectory, "assets.bin"), Buffer.from([0, 1, 2, 3]));

  const listed = await listSkillRepositorySkills();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "diagnose");
  assert.equal(listed[0].description, "Diagnose systems");
  assert.equal(listed[0].fileCount, 3);

  const imported = await getSkillRepositorySkillPackage("diagnose");
  assert.equal(imported.skillName, "diagnose");
  assert.match(imported.files["skills/diagnose/SKILL.md"], /name: diagnose/);
  assert.equal(imported.files["skills/diagnose/references/checklist.md"], "# Checklist\n");
  assert.equal(imported.binaryFiles["skills/diagnose/assets.bin"], Buffer.from([0, 1, 2, 3]).toString("base64"));
});

test("管理员导入并删除仓库技能", async () => {
  const created = await createSkillRepositorySkillFromZip(storedZip({
    "inspect/SKILL.md": "---\nname: inspect\ndescription: Inspect systems\n---\nSteps.\n",
    "inspect/guide.md": "Guide\n",
  }));
  assert.equal(created.name, "inspect");
  assert.equal(created.description, "Inspect systems");
  assert.equal(created.fileCount, 2);

  const loaded = await getSkillRepositorySkillPackage("inspect");
  assert.equal(loaded.files["skills/inspect/guide.md"], "Guide\n");

  await deleteSkillRepositorySkill("inspect");
  await assert.rejects(
    getSkillRepositorySkillPackage("inspect"),
    /技能不存在/,
  );
});

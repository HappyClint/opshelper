#!/usr/bin/env python3
"""Safely adapt one Skill ZIP for opshelper's /workspace runtime boundary."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import sys
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath


MAX_ENTRIES = 512
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_ENTRY_BYTES = 16 * 1024 * 1024
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FRONTMATTER_RE = re.compile(r"^(?:\ufeff)?---\r?\n(?P<body>[\s\S]*?)\r?\n---(?:\r?\n|$)")
IGNORED_NAMES = {".DS_Store", "Thumbs.db"}
RESERVED_PARTS = {".git", ".opencode", "node_modules", "__MACOSX"}
POLICY_MARKER = "<!-- opshelper-workspace-policy:v1 -->"
FORBIDDEN_PATTERNS = [
    (re.compile(r"(?<![\w])/(?:Users|root|mnt|private|var|opt|srv|data|home)/(?!workspace(?:/|\b))[^\s'\"`)]*"), "仍引用 /workspace 之外的数据路径"),
    (re.compile(r"(?<![\w])(?:~|\$HOME|\$\{HOME\})(?:/|\\)"), "仍引用 home 目录"),
    (re.compile(r"[A-Za-z]:\\"), "仍引用 Windows 绝对路径"),
    (re.compile(r"(?:^|\s)(?:pip3?|python3?\s+-m\s+pip|npm|pnpm|yarn|apt(?:-get)?|apk|brew)\s+install\b"), "包含运行时安装命令"),
    (re.compile(r"(?:^|[\s`])(?:soffice|libreoffice|pdftoppm|pandoc|uv|jq)(?:[\s`]|$)"), "引用当前 opshelper 运行镜像未提供的外部命令"),
]
WARNING_PATTERNS = [
    (re.compile(r"(?:^|[\s`])(?:curl|wget)(?:[\s`]|$)"), "包含下载命令，离线或受限网络中可能不可用"),
    (re.compile(r"(?:\.opencode/|opencode\.jsonc?\b)"), "引用项目级 OpenCode 配置；opshelper 不会把它作为受管配置来源"),
    (re.compile(r"https?://"), "包含网络地址，需确认目标运行环境可访问"),
]


class AdaptError(RuntimeError):
    pass


@dataclass
class Finding:
    severity: str
    path: str
    line: int
    message: str


@dataclass
class Result:
    skill_name: str = "unknown"
    rewrites: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)

    @property
    def blockers(self) -> list[Finding]:
        return [item for item in self.findings if item.severity == "BLOCK"]


def workspace_root() -> Path:
    root = Path(os.environ.get("OPSHELPER_WORKSPACE_ROOT", "/workspace"))
    if not root.is_absolute():
        raise AdaptError("OPSHELPER_WORKSPACE_ROOT 必须是绝对路径")
    return root.resolve()


def inside_workspace(raw: str | Path, *, must_exist: bool = False) -> Path:
    root = workspace_root()
    path = Path(raw)
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve(strict=must_exist)
    if resolved != root and root not in resolved.parents:
        raise AdaptError(f"路径必须位于 {root} 内：{path}")
    return resolved


def safe_member(name: str) -> tuple[str, ...]:
    normalized = name.replace("\\", "/").rstrip("/")
    path = PurePosixPath(normalized)
    parts = path.parts
    if not normalized or "\0" in normalized or path.is_absolute() or re.match(r"^[A-Za-z]:", normalized):
        raise AdaptError(f"ZIP 路径无效：{name}")
    if any(part in {"", ".", ".."} or part in RESERVED_PARTS for part in parts):
        raise AdaptError(f"ZIP 路径不安全：{name}")
    if str(path) != normalized:
        raise AdaptError(f"ZIP 路径未规范化：{name}")
    return parts


def is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF)


def scalar(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, str) else value
        except json.JSONDecodeError:
            return value
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def metadata(text: str) -> tuple[str, str]:
    matched = FRONTMATTER_RE.match(text)
    if not matched:
        raise AdaptError("SKILL.md 必须包含完整 frontmatter")
    values: dict[str, str] = {}
    for raw in matched.group("body").splitlines():
        if not raw.strip() or raw != raw.lstrip() or raw.lstrip().startswith("#"):
            continue
        entry = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", raw.strip())
        if entry:
            values[entry.group(1)] = scalar(entry.group(2))
    name = values.get("name", "").strip()
    description = values.get("description", "").strip()
    if len(name) > 64 or not NAME_RE.fullmatch(name):
        raise AdaptError("SKILL.md name 必须是最长 64 字符的小写 kebab-case")
    if not description or len(description) > 1024:
        raise AdaptError("SKILL.md description 必须非空且不超过 1024 字符")
    return name, description


def decode_text(data: bytes) -> str | None:
    if b"\0" in data:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text if text.encode("utf-8") == data else None


def injected_policy(name: str) -> str:
    return f"""{POLICY_MARKER}
## opshelper runtime boundary

- Treat `/workspace` as the only location for user inputs and all writes.
- Put final deliverables under `/workspace/outputs/` unless the user gives another path under `/workspace`.
- Put scratch data in `/workspace/.tmp/{name}/` and persistent skill-owned data in `/workspace/.opshelper/{name}/`.
- The installed skill directory is read-only and its runtime name may be prefixed. Resolve bundled resources from the base directory reported by the skill tool; never hardcode the install path or copy name.
- Do not modify OpenCode project/runtime configuration or install packages during a task. If a required dependency is unavailable, report it instead of claiming completion.

"""


def rewrite_text(text: str, name: str) -> tuple[str, list[str]]:
    replacements = [
        ("/home/oai/share", "/workspace", "OpenAI share directory"),  # opshelper-audit: allow-literal
        ("/mnt/data", "/workspace", "data mount"),  # opshelper-audit: allow-literal
        ("${XDG_CONFIG_HOME}", f"/workspace/.opshelper/{name}/config", "XDG config"),
        ("$XDG_CONFIG_HOME", f"/workspace/.opshelper/{name}/config", "XDG config"),
        ("${XDG_CACHE_HOME}", f"/workspace/.opshelper/{name}/cache", "XDG cache"),
        ("$XDG_CACHE_HOME", f"/workspace/.opshelper/{name}/cache", "XDG cache"),
        ("${XDG_STATE_HOME}", f"/workspace/.opshelper/{name}/state", "XDG state"),
        ("$XDG_STATE_HOME", f"/workspace/.opshelper/{name}/state", "XDG state"),
        ("${HOME}/.config", f"/workspace/.opshelper/{name}/config", "home config"),  # opshelper-audit: allow-literal
        ("$HOME/.config", f"/workspace/.opshelper/{name}/config", "home config"),  # opshelper-audit: allow-literal
        ("~/.config", f"/workspace/.opshelper/{name}/config", "home config"),  # opshelper-audit: allow-literal
        ("${HOME}/.cache", f"/workspace/.opshelper/{name}/cache", "home cache"),  # opshelper-audit: allow-literal
        ("$HOME/.cache", f"/workspace/.opshelper/{name}/cache", "home cache"),  # opshelper-audit: allow-literal
        ("~/.cache", f"/workspace/.opshelper/{name}/cache", "home cache"),  # opshelper-audit: allow-literal
        ("/home/node/.config", f"/workspace/.opshelper/{name}/config", "runtime config"),  # opshelper-audit: allow-literal
        ("/home/node/.cache", f"/workspace/.opshelper/{name}/cache", "runtime cache"),  # opshelper-audit: allow-literal
        ("/tmp", f"/workspace/.tmp/{name}", "temporary directory"),
    ]
    changed: list[str] = []
    for old, new, label in replacements:
        if old in text:
            text = text.replace(old, new)
            changed.append(f"{label}: {old} -> {new}")
    return text, changed


def inject_policy(text: str, name: str) -> str:
    if POLICY_MARKER in text:
        return text
    matched = FRONTMATTER_RE.match(text)
    if not matched:
        raise AdaptError("SKILL.md 缺少 frontmatter")
    return text[: matched.end()] + "\n" + injected_policy(name) + text[matched.end() :]


def prepare(source_raw: str, work_raw: str | None) -> tuple[Path, Path, Result]:
    source = inside_workspace(source_raw, must_exist=True)
    if not source.is_file() or source.suffix.lower() != ".zip":
        raise AdaptError(f"源文件必须是 ZIP：{source}")
    if work_raw:
        work = inside_workspace(work_raw)
    else:
        stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", source.stem).strip("-.") or "skill"
        work = inside_workspace(workspace_root() / ".opshelper-skill-adapter" / f"{stem}-{uuid.uuid4().hex[:8]}")
    if work.exists():
        raise AdaptError(f"工作目录已存在，拒绝覆盖：{work}")
    skill_dir = work / "skill"
    skill_dir.mkdir(parents=True)

    entries: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
    total = 0
    try:
        with zipfile.ZipFile(source) as archive:
            seen_names: set[str] = set()
            for info in archive.infolist():
                if info.is_dir():
                    continue
                parts = safe_member(info.filename)
                if any(part == "__MACOSX" for part in parts) or parts[-1] in IGNORED_NAMES:
                    continue
                if is_symlink(info):
                    raise AdaptError(f"ZIP 禁止符号链接：{info.filename}")
                canonical_name = "/".join(parts)
                if canonical_name in seen_names:
                    raise AdaptError(f"ZIP 包含重复文件：{canonical_name}")
                seen_names.add(canonical_name)
                if info.flag_bits & 0x1:
                    raise AdaptError(f"ZIP 不支持加密文件：{info.filename}")
                if info.file_size > MAX_ENTRY_BYTES:
                    raise AdaptError(f"单文件超过 16 MiB：{info.filename}")
                total += info.file_size
                if total > MAX_TOTAL_BYTES:
                    raise AdaptError("ZIP 解压后总大小超过 32 MiB")
                entries.append((info, parts))
            if len(entries) > MAX_ENTRIES:
                raise AdaptError("ZIP 文件数超过 512")
            skill_docs = [(info, parts) for info, parts in entries if parts[-1] == "SKILL.md"]
            if len(skill_docs) != 1:
                raise AdaptError("ZIP 必须包含且只能包含一个 SKILL.md")
            root_parts = skill_docs[0][1][:-1]
            for _, parts in entries:
                if parts[: len(root_parts)] != root_parts:
                    raise AdaptError("ZIP 包含 SKILL.md 所在技能目录之外的文件")

            skill_info = skill_docs[0][0]
            skill_text = decode_text(archive.read(skill_info))
            if skill_text is None:
                raise AdaptError("SKILL.md 必须是 UTF-8 文本")
            skill_name, _ = metadata(skill_text)
            result = Result(skill_name=skill_name)

            for info, parts in entries:
                relative = parts[len(root_parts) :]
                target = skill_dir.joinpath(*relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                data = archive.read(info)
                text = decode_text(data)
                if text is not None:
                    text, changes = rewrite_text(text, skill_name)
                    if relative == ("SKILL.md",):
                        text = inject_policy(text, skill_name)
                    if changes:
                        result.rewrites.extend(f"{'/'.join(relative)}: {change}" for change in changes)
                    target.write_text(text, encoding="utf-8")
                else:
                    target.write_bytes(data)
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise

    result = audit_tree(skill_dir, prior_rewrites=result.rewrites)
    report = write_report(work, skill_dir, result)
    return skill_dir, report, result


def add_finding(result: Result, severity: str, path: Path, line: int, message: str) -> None:
    result.findings.append(Finding(severity, path.as_posix(), line, message))


def scan_text(result: Result, relative: Path, text: str) -> None:
    for number, line in enumerate(text.splitlines(), 1):
        if "opshelper-audit: allow-literal" in line:
            continue
        for pattern, message in FORBIDDEN_PATTERNS:
            if pattern.search(line):
                add_finding(result, "BLOCK", relative, number, message)
        for pattern, message in WARNING_PATTERNS:
            if pattern.search(line):
                add_finding(result, "WARN", relative, number, message)


def audit_tree(skill_raw: str | Path, prior_rewrites: list[str] | None = None) -> Result:
    skill_dir = inside_workspace(skill_raw, must_exist=True)
    if not skill_dir.is_dir():
        raise AdaptError(f"技能工作副本不是目录：{skill_dir}")
    all_items = list(skill_dir.rglob("*"))
    if any(item.is_symlink() for item in all_items):
        raise AdaptError("技能目录禁止符号链接")
    files = [item for item in all_items if item.is_file()]
    if len(files) > MAX_ENTRIES:
        raise AdaptError("技能文件数超过 512")
    total = sum(item.stat().st_size for item in files)
    if total > MAX_TOTAL_BYTES:
        raise AdaptError("技能目录总大小超过 32 MiB")
    for item in files:
        relative_parts = item.relative_to(skill_dir).parts
        if any(part in RESERVED_PARTS for part in relative_parts):
            raise AdaptError(f"技能目录包含保留路径：{item.relative_to(skill_dir)}")
        if item.stat().st_size > MAX_ENTRY_BYTES:
            raise AdaptError(f"单文件超过 16 MiB：{item.relative_to(skill_dir)}")
        if item.name == ".env" or (item.name.startswith(".env.") and item.name != ".env.example"):
            raise AdaptError(f"技能包不得包含环境凭据文件：{item.relative_to(skill_dir)}")

    skill_docs = [item for item in files if item.name == "SKILL.md"]
    if len(skill_docs) != 1 or skill_docs[0] != skill_dir / "SKILL.md":
        raise AdaptError("工作副本根目录必须包含且只能包含一个 SKILL.md")
    skill_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    name, _ = metadata(skill_text)
    result = Result(skill_name=name, rewrites=list(prior_rewrites or []))
    if POLICY_MARKER not in skill_text:
        add_finding(result, "BLOCK", Path("SKILL.md"), 1, "缺少 opshelper /workspace 运行约束块")

    for item in files:
        relative = item.relative_to(skill_dir)
        text = decode_text(item.read_bytes())
        if text is None:
            continue
        scan_text(result, relative, text)
    return result


def report_text(skill_dir: Path, result: Result) -> str:
    lines = [
        "# opshelper Skill Adaptation Report",
        "",
        f"- Skill: `{result.skill_name}`",
        f"- Working copy: `{skill_dir}`",
        f"- Blocking findings: {len(result.blockers)}",
        f"- Warnings: {sum(item.severity == 'WARN' for item in result.findings)}",
        "",
        "## Automatic rewrites",
        "",
    ]
    lines.extend(f"- {item}" for item in result.rewrites)
    if not result.rewrites:
        lines.append("- None")
    lines.extend(["", "## Findings", ""])
    lines.extend(f"- [{item.severity}] `{item.path}:{item.line}` {item.message}" for item in result.findings)
    if not result.findings:
        lines.append("- None")
    lines.extend([
        "",
        "Resolve every BLOCK item before packaging. WARN items require an explicit compatibility judgment.",
        "",
    ])
    return "\n".join(lines)


def write_report(work: Path, skill_dir: Path, result: Result) -> Path:
    report = work / "ADAPTATION_REPORT.md"
    report.write_text(report_text(skill_dir, result), encoding="utf-8")
    return report


def print_result(skill_dir: Path, report: Path | None, result: Result) -> None:
    print(f"skill={result.skill_name}")
    print(f"working_copy={skill_dir}")
    if report:
        print(f"report={report}")
    print(f"blockers={len(result.blockers)} warnings={sum(item.severity == 'WARN' for item in result.findings)}")
    for item in result.findings:
        print(f"{item.severity} {item.path}:{item.line} {item.message}")


def pack(skill_raw: str, output_raw: str) -> tuple[Path, Result]:
    skill_dir = inside_workspace(skill_raw, must_exist=True)
    output = inside_workspace(output_raw)
    if output.exists():
        raise AdaptError(f"输出已存在，拒绝覆盖：{output}")
    result = audit_tree(skill_dir)
    if result.blockers:
        raise AdaptError(f"仍有 {len(result.blockers)} 个阻断项，不能打包")
    output.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(item for item in skill_dir.rglob("*") if item.is_file())
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in files:
            relative = item.relative_to(skill_dir).as_posix()
            info = zipfile.ZipInfo(f"{result.skill_name}/{relative}", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 & 0xFFFF) << 16
            archive.writestr(info, item.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return output, result


def inspect_zip(source_raw: str) -> Result:
    source = inside_workspace(source_raw, must_exist=True)
    result = Result()
    total = 0
    count = 0
    skill_docs: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
    entries: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
    with zipfile.ZipFile(source) as archive:
        seen_names: set[str] = set()
        for info in archive.infolist():
            if info.is_dir():
                continue
            parts = safe_member(info.filename)
            if any(part == "__MACOSX" for part in parts) or parts[-1] in IGNORED_NAMES:
                continue
            if is_symlink(info):
                raise AdaptError(f"ZIP 禁止符号链接：{info.filename}")
            canonical_name = "/".join(parts)
            if canonical_name in seen_names:
                raise AdaptError(f"ZIP 包含重复文件：{canonical_name}")
            seen_names.add(canonical_name)
            if info.flag_bits & 0x1:
                raise AdaptError(f"ZIP 不支持加密文件：{info.filename}")
            count += 1
            total += info.file_size
            if count > MAX_ENTRIES or total > MAX_TOTAL_BYTES or info.file_size > MAX_ENTRY_BYTES:
                raise AdaptError("ZIP 超出 opshelper 数量或大小限制")
            entries.append((info, parts))
            if parts[-1] == "SKILL.md":
                skill_docs.append((info, parts))
        if len(skill_docs) != 1:
            raise AdaptError("ZIP 必须包含且只能包含一个 SKILL.md")
        root_parts = skill_docs[0][1][:-1]
        if any(parts[: len(root_parts)] != root_parts for _, parts in entries):
            raise AdaptError("ZIP 包含技能目录之外的文件")
        text = decode_text(archive.read(skill_docs[0][0]))
        if text is None:
            raise AdaptError("SKILL.md 必须是 UTF-8 文本")
        name, _ = metadata(text)
        result.skill_name = name
        if POLICY_MARKER not in text:
            result.findings.append(Finding("BLOCK", "/".join(skill_docs[0][1]), 1, "缺少 opshelper 运行约束块"))
        for info, parts in entries:
            if parts[-1] == ".env" or (parts[-1].startswith(".env.") and parts[-1] != ".env.example"):
                raise AdaptError(f"技能包不得包含环境凭据文件：{'/'.join(parts)}")
            entry_text = decode_text(archive.read(info))
            if entry_text is not None:
                scan_text(result, Path(*parts[len(root_parts) :]), entry_text)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    prepare_parser = commands.add_parser("prepare", help="安全解包、自动改写并生成报告")
    prepare_parser.add_argument("source_zip")
    prepare_parser.add_argument("work_dir", nargs="?")

    audit_parser = commands.add_parser("audit", help="审计已修改的工作副本")
    audit_parser.add_argument("skill_dir")

    pack_parser = commands.add_parser("pack", help="审计通过后生成可导入 ZIP")
    pack_parser.add_argument("skill_dir")
    pack_parser.add_argument("output_zip")

    adapt_parser = commands.add_parser("adapt", help="准备并在无阻断项时直接打包")
    adapt_parser.add_argument("source_zip")
    adapt_parser.add_argument("output_zip")
    adapt_parser.add_argument("--work-dir")

    inspect_parser = commands.add_parser("inspect", help="检查最终 ZIP 的导入结构")
    inspect_parser.add_argument("source_zip")

    args = parser.parse_args()
    try:
        if args.command == "prepare":
            skill_dir, report, result = prepare(args.source_zip, args.work_dir)
            print_result(skill_dir, report, result)
            return 2 if result.blockers else 0
        if args.command == "audit":
            skill_dir = inside_workspace(args.skill_dir, must_exist=True)
            result = audit_tree(skill_dir)
            report = write_report(skill_dir.parent, skill_dir, result)
            print_result(skill_dir, report, result)
            return 2 if result.blockers else 0
        if args.command == "pack":
            output, result = pack(args.skill_dir, args.output_zip)
            print(f"created={output}")
            print(f"skill={result.skill_name}")
            print(f"warnings={sum(item.severity == 'WARN' for item in result.findings)}")
            return 0
        if args.command == "adapt":
            skill_dir, report, result = prepare(args.source_zip, args.work_dir)
            print_result(skill_dir, report, result)
            if result.blockers:
                return 2
            output, _ = pack(str(skill_dir), args.output_zip)
            print(f"created={output}")
            return 0
        if args.command == "inspect":
            result = inspect_zip(args.source_zip)
            print(f"skill={result.skill_name}")
            print(f"blockers={len(result.blockers)}")
            return 2 if result.blockers else 0
    except (AdaptError, OSError, zipfile.BadZipFile) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""opshelper 单机安装和停写备份；仅 Python 标准库与 Docker Compose v2。"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parent.parent
ROOTS = {'agents', 'config', 'users'}


def run(args, *, capture=False, input=None):
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        # compose config / DB errors may contain credentials; do not echo captured output.
        raise RuntimeError(f'命令失败（退出 {result.returncode}）：{args[0]} {args[1]}；请在本机检查服务状态')
    return result.stdout if capture else b''


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hash_stream(stream)


def hash_stream(stream):
    h = hashlib.sha256()
    for part in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(part)
    return h.hexdigest()


def canonical(path):
    value = Path(path).absolute()
    for part in [value, *value.parents]:
        if part.is_symlink():
            raise ValueError('路径及父目录不能是符号链接')
    return value.resolve()


def independent(a, b):
    if a == b or a in b.parents or b in a.parents:
        raise ValueError('备份、源数据和恢复目录必须互相独立，不能包含彼此')


def validated_members(archive):
    names = set()
    members = archive.getmembers()
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in ROOTS:
            raise ValueError('备份含越界路径')
        normalized = str(path)
        if normalized in names or not (member.isfile() or member.isdir()):
            raise ValueError('备份含重复路径或不支持的文件类型')
        names.add(normalized)
    return members


def is_empty_prepared_root(root):
    allowed = {
        Path('postgres'), Path('agents'), Path('config'), Path('config/opencode'),
        Path('users'), Path('backups'),
    }
    for item in root.rglob('*'):
        if item.is_symlink() or not item.is_dir() or item.relative_to(root) not in allowed:
            return False
    return True


def deployment_images(config):
    # Maintenance services reuse application/database images. Their names may
    # change between releases and must not invalidate an otherwise exact backup.
    names = ['postgres', 'api', 'worker', 'web', 'nginx']
    images = {name: config['services'][name]['image'] for name in names}
    images['runtime'] = config['services']['api']['environment']['OPENCODE_DOCKER_IMAGE']
    return images


class Deployment:
    def __init__(self, args):
        self.env = canonical(args.env_file)
        self.compose = canonical(args.compose_file)
        self.command = ['docker', 'compose', '--env-file', str(self.env), '-f', str(self.compose)]
        self.config = json.loads(self.dc('config', '--format', 'json', capture=True))
        self.project = self.config['name']
        api = self.config['services']['api']['environment']
        self.root = canonical(api['DATA_ROOT_HOST'])
        self.uid = int(self.config['services']['api']['user'].split(':')[0])
        self.gid = int(self.config['services']['api']['user'].split(':')[1])
        if self.root == Path('/') or self.root == REPO:
            raise ValueError('数据路径不能是系统或源码根目录')

    def dc(self, *args, **kwargs):
        return run([*self.command, *args], **kwargs)

    def sql(self, query):
        return self.dc('exec', '-T', 'postgres', 'psql', '-U', 'opshelper', '-d', 'opshelper', '-At', '-c', query, capture=True).decode().strip()

    def runtimes(self):
        ids = run(['docker', 'ps', '-aq', '--filter', 'label=opshelper.managed=true'], capture=True).decode().split()
        if not ids:
            return []
        containers = json.loads(run(['docker', 'inspect', *ids], capture=True))
        prefix = str(self.root / 'users') + '/'
        normalize = str.casefold if sys.platform == 'darwin' else lambda value: value
        return [c for c in containers if any(normalize(m.get('Source', '')).startswith(normalize(prefix)) for m in c['Mounts'])]

    def migrate(self):
        self.verify_bind()
        self.dc('up', '-d', '--wait', 'postgres')
        self.dc('run', '--rm', '--no-deps', 'migrate')

    def bootstrap(self):
        self.migrate()
        self.dc('run', '--rm', '--no-deps', 'bootstrap')

    def up(self):
        self.migrate()
        self.dc('up', '-d', '--no-deps', '--wait', 'api', 'worker', 'web', 'nginx')

    def down(self):
        self.dc('stop', 'nginx', 'web', 'worker', 'api', 'postgres')
        runtimes = self.runtimes()
        running = [c['Id'] for c in runtimes if c['State']['Running']]
        if running:
            run(['docker', 'stop', *running])

    def verify_bind(self):
        # Detect stale Desktop VM bind mappings before touching the database.
        self.root.mkdir(parents=True, exist_ok=True)
        marker = self.root / ('.bind-check-' + secrets.token_hex(8))
        token = secrets.token_hex(24)
        marker.write_text(token)
        try:
            output = run(['docker', 'run', '--rm', '--network', 'none', '--mount',
                          f'type=bind,source={self.root},target=/probe,readonly',
                          '--entrypoint', 'node', self.config['services']['api']['image'],
                          '-e', "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
                          '/probe/' + marker.name], capture=True).decode()
            if output != token:
                raise ValueError('Docker bind 与宿主目录不一致，请改用从未挂载的新目录')
        finally:
            marker.unlink(missing_ok=True)


def init(args):
    target = canonical(args.env_file)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise ValueError('配置文件已存在，拒绝覆盖')
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,40}', args.project):
        raise ValueError('部署名使用小写字母、数字和短横线，至少两位')
    root = canonical(args.data_root or target.parent / 'data')
    if root.exists() and any(root.iterdir()):
        raise ValueError('首次安装必须使用空数据目录')
    socket = Path('/var/run/docker.sock')
    if not socket.exists():
        socket = Path.home() / '.orbstack/run/docker.sock'
    values = {
        'COMPOSE_PROJECT_NAME': args.project, 'DATA_ROOT_HOST': str(root),
        'OPSHELPER_UID': str(os.getuid()), 'OPSHELPER_GID': str(os.getgid()),
        # Desktop Docker exposes a VM-side root-owned socket; the macOS socket's
        # staff group does not describe its bind inside Linux containers.
        'OPSHELPER_DOCKER_GID': str(0 if sys.platform == 'darwin' else socket.stat().st_gid if socket.exists() else 0),
        'POSTGRES_PASSWORD': secrets.token_urlsafe(32), 'OPSHELPER_ADMIN_PASSWORD': secrets.token_urlsafe(24),
        'OPSHELPER_HTTP_HOST': '127.0.0.1', 'OPSHELPER_HTTP_PORT': str(args.port),
        'OPSHELPER_SESSION_COOKIE_NAME': args.project.replace('-', '_') + '_session',
        'OPENCODE_DOCKER_IMAGE': 'opshelper/opencode-runtime:2.0.27',
    }
    # Compose interpolation is disabled by single quotes; reject newlines/quotes in paths.
    if any("'" in value or '\n' in value or '\r' in value for value in values.values()):
        raise ValueError('配置路径含不支持的字符')
    with target.open('x') as stream:
        os.chmod(target, 0o600)
        stream.write(''.join(f"{key}='{value}'\n" for key, value in values.items()))
    run(['bash', str(REPO / 'scripts/prepare-data.sh'), str(root)])
    print(f'配置已生成：{target}（权限 600）。管理员 admin 的初始密码保存在 OPSHELPER_ADMIN_PASSWORD，终端不输出。')


def backup(args):
    deployment = Deployment(args)
    deployment.verify_bind()
    out = canonical(args.output)
    independent(deployment.root, out)
    if out.exists():
        raise ValueError('备份目标已存在，拒绝覆盖')
    # Stop registration and entrypoints first, then check DB: no race with a final browser submission.
    deployment.dc('stop', 'nginx', 'web', 'worker', 'api')
    pending = int(deployment.sql('SELECT count(*) FROM "Execution" WHERE status IN (\'QUEUED\',\'DISPATCHING\',\'RUNNING\',\'WAITING_INPUT\')'))
    recovery = int(deployment.sql("SELECT count(*) FROM \"ContainerInstance\" WHERE \"executionRecoveryRequired\" OR \"configApplyStatus\" NOT IN ('READY','FROZEN')"))
    if pending or recovery:
        raise ValueError('仍有待执行/待处理/恢复或配置变更，请先 up，处理完后重新备份；应用当前保持停止')
    runtimes = deployment.runtimes()
    running = [c['Id'] for c in runtimes if c['State']['Running']]
    if running:
        run(['docker', 'stop', *running])
    out.mkdir(parents=True, mode=0o700)
    os.chmod(out, 0o700)
    dump = deployment.dc('exec', '-T', 'postgres', 'pg_dump', '-U', 'opshelper', '-d', 'opshelper', '-Fc', '--no-owner', '--no-acl', capture=True)
    (out / 'database.dump').write_bytes(dump)
    with tarfile.open(out / 'data.tar', 'w') as archive:
        for name in sorted(ROOTS):
            if not (deployment.root / name).is_dir() or (deployment.root / name).is_symlink():
                raise ValueError('数据根不完整或含不安全链接')
            archive.add(deployment.root / name, arcname=name)
    with tarfile.open(out / 'data.tar') as archive:
        validated_members(archive)
    # .env is needed to recover installation configuration; it contains secrets.
    shutil.copyfile(deployment.env, out / 'deployment.env')
    images = deployment_images(deployment.config)
    image_ids = {}
    for name, tag in images.items():
        image_ids[name] = json.loads(run(['docker', 'image', 'inspect', tag], capture=True))[0]['Id']
    manifest = {
        'format': 'opshelper-backup-v1', 'createdAt': datetime.now(timezone.utc).isoformat(),
        'sourceRoot': str(deployment.root), 'project': deployment.project,
        'postgresVersion': deployment.sql('SHOW server_version'),
        'uid': deployment.uid, 'gid': deployment.gid, 'images': images, 'imageIds': image_ids,
        'sha256': {name: digest(out / name) for name in ['database.dump', 'data.tar', 'deployment.env']},
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for item in out.iterdir():
        item.chmod(0o600)
    print(f'停写备份完成：{out}。应用和用户容器保持停止；可用 up 恢复源服务。')


def restore(args):
    deployment = Deployment(args)
    source = canonical(args.backup)
    independent(deployment.root, source)
    manifest = json.loads((source / 'manifest.json').read_text())
    if manifest.get('format') != 'opshelper-backup-v1':
        raise ValueError('不支持的备份版本')
    independent(deployment.root, canonical(manifest['sourceRoot']))
    if set(manifest['sha256']) != {'database.dump', 'data.tar', 'deployment.env'}:
        raise ValueError('备份清单文件集合不完整')
    for name, expected in manifest['sha256'].items():
        if (source / name).is_symlink() or digest(source / name) != expected:
            raise ValueError(f'备份校验失败：{name}')
    if deployment.uid != manifest['uid'] or deployment.gid != manifest['gid']:
        raise ValueError('恢复需保持原 UID/GID；跨身份迁移应先独立审核文件所有权方案')
    specs = deployment_images(deployment.config)
    for name, tag in specs.items():
        actual = json.loads(run(['docker', 'image', 'inspect', tag], capture=True))[0]['Id']
        if actual != manifest['imageIds'].get(name):
            raise ValueError(f'恢复必须使用备份时同一镜像：{name}')
    if deployment.dc('ps', '-aq', capture=True).strip():
        raise ValueError('目标部署已有容器，请使用全新部署名')
    if not is_empty_prepared_root(deployment.root):
        raise ValueError('恢复数据目录非空，拒绝覆盖')
    with tarfile.open(source / 'data.tar') as archive:
        members = validated_members(archive)
        # One user's native session IDs cannot run twice on the same daemon.
        user_ids = {PurePosixPath(m.name).parts[1] for m in members if m.name.startswith('users/') and len(PurePosixPath(m.name).parts) > 1}
        existing = set(run(['docker', 'ps', '-a', '--format', '{{.Names}}'], capture=True).decode().splitlines())
        if any('opshelper-user-' + uid in existing for uid in user_ids):
            raise ValueError('同一 Docker 上仍有源用户容器。保持源平台停止，删除已停止的源容器对象（保留 bind 数据）后再恢复')
        deployment.root.mkdir(parents=True, exist_ok=True)
        # Members validated above, destination empty, and links have no archived descendants.
        archive.extractall(deployment.root, members=members)
    deployment.dc('up', '-d', '--wait', 'postgres')
    if int(deployment.sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")):
        raise ValueError('目标数据库非空，拒绝恢复')
    deployment.dc('exec', '-T', 'postgres', 'pg_restore', '-U', 'opshelper', '-d', 'opshelper', '--no-owner', '--no-acl', '--single-transaction', input=(source / 'database.dump').read_bytes())
    # Dynamic containers are reconstructed from restored files on the next demand.
    deployment.sql('UPDATE "ContainerInstance" SET "dockerContainerId"=NULL, status=\'STOPPED\', "lastWakeAttemptAt"=NULL, "lifecycleLockOwner"=NULL, "lifecycleLockedAt"=NULL, "executionLeaseOwner"=NULL, "executionLeaseExpiresAt"=NULL, "activeExecutionId"=NULL')
    print('恢复完成，应用尚未启动。核对 .env、端口与模型配置后执行 up；源平台保持停止。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default=str(REPO / '.env'))
    parser.add_argument('--compose-file', default=str(REPO / 'docker-compose.yml'))
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('init'); p.add_argument('--project', default='opshelper'); p.add_argument('--port', type=int, default=8080); p.add_argument('--data-root')
    sub.add_parser('bootstrap', help='仅空数据库：迁移后创建初始管理员')
    sub.add_parser('up')
    sub.add_parser('down', aliases=['stop'], help='停止平台与当前部署的用户容器')
    sub.add_parser('status')
    p = sub.add_parser('backup'); p.add_argument('--output', required=True)
    p = sub.add_parser('restore'); p.add_argument('--backup', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'init': init(args)
    elif args.action == 'backup': backup(args)
    elif args.action == 'restore': restore(args)
    elif args.action == 'bootstrap': Deployment(args).bootstrap()
    elif args.action == 'up': Deployment(args).up()
    elif args.action in {'down', 'stop'}: Deployment(args).down()
    else: Deployment(args).dc('ps')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        raise SystemExit(str(error))

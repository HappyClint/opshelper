#!/usr/bin/env python3
"""开发环境 V1 -> V2 切换；默认只预览，保留账号、配置和工作文件。"""
import argparse
import json
import os
from datetime import datetime, timezone

from opshelper import Deployment, REPO, run


RESET_SQL = '''BEGIN;
DELETE FROM "Conversation";
DELETE FROM "ScheduleRun";
UPDATE "Schedule" SET status='PAUSED', "statusReason"='OpenCode 2 切换后请重新确认并启用';
UPDATE "ContainerInstance" SET status='STOPPED', "dockerContainerId"=NULL,
  "activeExecutionId"=NULL, "executionLeaseOwner"=NULL, "executionLeaseExpiresAt"=NULL,
  "executionRecoveryRequired"=false, "executionRecoveryReason"=NULL,
  "lifecycleLockOwner"=NULL, "lifecycleLockedAt"=NULL, "lastWakeAttemptAt"=NULL,
  "desiredRuntimeHash"=NULL, "appliedRuntimeHash"=NULL,
  "configApplyStatus"='REVOKING', "configApplyAttemptId"=NULL, "configApplyError"=NULL, "drainingRuntimeState"='[]'::jsonb,
  "desiredGeneration"="desiredGeneration"+1;
COMMIT;'''


def cutover(args):
    deployment = Deployment(args)
    # config is included in deployment backups, so a restored V2 installation
    # cannot accidentally run the destructive first-cutover step again.
    marker = deployment.root / 'config' / '.opencode2-cutover.json'
    if marker.exists():
        print('此数据目录已切换到 V2，不重复清空会话。')
        return
    counts = deployment.sql('SELECT json_build_object(\'conversations\', (SELECT count(*) FROM "Conversation"), '
                            '\'executions\', (SELECT count(*) FROM "Execution"), '
                            '\'schedules\', (SELECT count(*) FROM "Schedule"))')
    print(f'目标部署：{deployment.project}；数据目录：{deployment.root}')
    print(f'将删除旧会话及执行记录、调度历史，并暂停定时任务：{counts}')
    print('保留账号、智能体、模型配置、工作文件以及旧 V1 状态目录；V2 使用 state/v2。')
    if not args.discard_history:
        print('仅预览。执行需显式添加 --discard-history。')
        return
    deployment.verify_bind()
    image = deployment.config['services']['api']['environment']['OPENCODE_DOCKER_IMAGE']
    version = run(['docker', 'run', '--rm', '--network', 'none', '--tmpfs', '/state:mode=1777',
                   '--tmpfs', '/tmp:mode=1777', image, 'opencode2', '--version'], capture=True).decode().strip()
    if version != 'opencode v2.0.27':
        raise ValueError('配置的执行镜像不是已验证的 OpenCode 2.0.27')
    deployment.dc('stop', 'nginx', 'web', 'worker', 'api')
    pending = int(deployment.sql('SELECT count(*) FROM "Execution" WHERE status IN '
                                 "('QUEUED','DISPATCHING','RUNNING','WAITING_INPUT')"))
    if pending:
        raise ValueError('仍有未完成任务；应用保持停止。先恢复旧版本并结束任务，再切换。')
    runtimes = deployment.runtimes()
    for container in runtimes:
        if container['State']['Running']:
            run(['docker', 'stop', container['Id']])
        run(['docker', 'rm', container['Id']])
    deployment.sql(RESET_SQL)
    marker.write_text(json.dumps({'version': 2, 'runtime': version,
                                 'completedAt': datetime.now(timezone.utc).isoformat()}, indent=2) + '\n')
    print('数据切换完成；服务保持停止。用新应用镜像执行 scripts/opshelper.py up，不运行 bootstrap。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default=str(REPO / '.env'))
    parser.add_argument('--compose-file', default=str(REPO / 'docker-compose.yml'))
    parser.add_argument('--discard-history', action='store_true')
    os.umask(0o077)
    try:
        cutover(parser.parse_args())
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        raise SystemExit(str(error))

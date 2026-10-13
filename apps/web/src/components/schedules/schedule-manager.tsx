"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatModelOption,
  ConversationAgent,
  ConversationAttachment,
  ExecutionStatus,
  ScheduleDetailResponse,
  ScheduleInput,
  ScheduleRunSummary,
  ScheduleSummary,
} from "@opshelper/shared";
import { formatShanghaiDateTime } from "@opshelper/shared";

import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleRunAnswer,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  runSchedule,
  updateSchedule,
} from "@/lib/browser-api";
import { type FileInfo, parentPath, rootPath } from "@/components/file-manager/utils";
import { guessMime } from "@/components/chat/format";
import { renderAssistantMarkdown } from "@/components/chat/markdown";
import { IconClock, IconPlus } from "@/components/chat/icons";
import { confirm as confirmDialog } from "@/components/ui/dialog-host";

export const SCHEDULE_DRAFT_KEY = "opshelper:schedule-draft";

type FormState = {
  id: string | null;
  name: string;
  prompt: string;
  leadAgentKey: string;
  participantAgentKeys: string[];
  attachments: ConversationAttachment[];
  model: string;
  autoApprovePermissions: boolean;
  frequency: "once" | "daily" | "weekly" | "cron";
  localDate: string;
  localTime: string;
  weekday: number;
  cronExpression: string;
};

function nextDefaultTime() {
  const value = new Date(Date.now() + 10 * 60_000 + 8 * 60 * 60_000)
    .toISOString();
  return { localDate: value.slice(0, 10), localTime: value.slice(11, 16) };
}

function clientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function emptyForm(agents: ConversationAgent[], defaultModel: string): FormState {
  const time = nextDefaultTime();
  const leadAgent = agents.find((agent) => agent.mode !== "subagent");
  return {
    id: null,
    name: "",
    prompt: "",
    leadAgentKey: leadAgent?.key ?? "",
    participantAgentKeys: [],
    attachments: [],
    model: defaultModel,
    autoApprovePermissions: false,
    frequency: "daily",
    localDate: time.localDate,
    localTime: time.localTime,
    weekday: 1,
    cronExpression: "0 9 * * 1-5",
  };
}

function scheduleForm(schedule: ScheduleSummary): FormState {
  return {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    leadAgentKey: schedule.leadAgentKey,
    participantAgentKeys: schedule.participantAgentKeys,
    attachments: schedule.attachments,
    model: schedule.model ?? "",
    autoApprovePermissions: schedule.autoApprovePermissions,
    frequency: schedule.frequency,
    localDate: schedule.localDate ?? nextDefaultTime().localDate,
    localTime: schedule.localTime,
    weekday: schedule.weekday ?? 1,
    cronExpression: schedule.cronExpression ?? "0 9 * * 1-5",
  };
}

function inputOf(form: FormState): ScheduleInput {
  const rule = form.frequency === "once"
    ? { frequency: "once" as const, localDate: form.localDate, localTime: form.localTime }
    : form.frequency === "weekly"
      ? { frequency: "weekly" as const, weekday: form.weekday, localTime: form.localTime }
      : form.frequency === "cron"
        ? { frequency: "cron" as const, cronExpression: form.cronExpression }
        : { frequency: "daily" as const, localTime: form.localTime };
  return {
    name: form.name,
    prompt: form.prompt,
    leadAgentKey: form.leadAgentKey,
    participantAgentKeys: form.participantAgentKeys,
    attachments: form.attachments,
    autoApprovePermissions: form.autoApprovePermissions,
    ...(form.model ? { model: form.model } : {}),
    rule,
  };
}

const weekdayLabels = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const statusLabels: Record<ScheduleSummary["status"], string> = {
  active: "运行中",
  paused: "已暂停",
  completed: "单次已完成",
};
const executionLabels: Record<ExecutionStatus, string> = {
  queued: "排队中",
  dispatching: "准备执行",
  running: "执行中",
  waiting_input: "等待你处理",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "状态待核对",
};

function ruleLabel(schedule: ScheduleSummary) {
  if (schedule.frequency === "once") {
    return schedule.localDate
      ? `${schedule.localDate.replace(/-/g, "/")} ${schedule.localTime}`
      : schedule.localTime;
  }
  if (schedule.frequency === "weekly") return `每${weekdayLabels[schedule.weekday ?? 1]} ${schedule.localTime}`;
  if (schedule.frequency === "cron") return `Crontab · ${schedule.cronExpression ?? ""}`;
  return `每天 ${schedule.localTime}`;
}

function runStatus(run: ScheduleRunSummary) {
  return run.decision === "skipped"
    ? "已跳过"
    : run.execution
      ? executionLabels[run.execution.status]
      : "已登记";
}

function triggerLabel(run: ScheduleRunSummary) {
  return run.trigger === "manual" ? "手动触发" : "计划触发";
}

const runResultEmptyText: Record<ExecutionStatus, string> = {
  queued: "任务已加入执行队列，开始后会在这里显示模型返回结果。",
  dispatching: "任务正在发送给智能体，稍后可在这里查看模型返回结果。",
  running: "任务正在执行，完成后会在这里显示模型返回结果。",
  waiting_input: "任务正在等待你处理，处理后会继续执行并在这里显示结果。",
  succeeded: "本次执行没有返回文字结果，可查看输出文件或打开完整对话。",
  failed: "本次执行没有返回模型结果，失败原因见上方说明。",
  cancelled: "任务已取消，没有模型返回结果。",
  interrupted: "执行状态待核对，暂时没有可以展示的模型结果。",
};

function dialogKeyDown(
  event: React.KeyboardEvent,
  container: HTMLElement | null,
  onClose: () => void,
  canClose = true,
) {
  if (event.key === "Escape") {
    if (canClose) { event.preventDefault(); onClose(); }
    return;
  }
  if (event.key !== "Tab") return;
  const elements = Array.from(container?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? []);
  const first = elements[0];
  const last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

function useDialogFocus(container: React.RefObject<HTMLElement | null>, selector: string) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.querySelector<HTMLElement>(selector)?.focus();
    return () => previous?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export function ScheduleManager({
  models,
  defaultModel,
}: {
  models: ChatModelOption[];
  defaultModel: string;
}) {
  const [agents, setAgents] = useState<ConversationAgent[]>([]);
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScheduleDetailResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const refresh = useCallback(async (preferredId?: string | null, quiet = false) => {
    try {
      const home = await listSchedules();
      setAgents(home.agents);
      setSchedules(home.schedules);
      const nextId = preferredId === undefined
        ? selectedId ?? home.schedules[0]?.id ?? null
        : preferredId;
      setSelectedId(nextId);
      if (nextId) setDetail(await getSchedule(nextId));
      else setDetail(null);
      if (!quiet) setNotice(null);
      return home;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "定时任务加载失败" });
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh().then((home) => {
      if (!home) return;
      try {
        const raw = sessionStorage.getItem(SCHEDULE_DRAFT_KEY);
        if (!raw) return;
        sessionStorage.removeItem(SCHEDULE_DRAFT_KEY);
        const draft = JSON.parse(raw) as Partial<FormState>;
        setForm({ ...emptyForm(home.agents, defaultModel), ...draft, id: null });
      } catch {
        // Ignore malformed browser state.
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => void refresh(undefined, true), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 切换任务时关闭结果弹窗，避免切回原任务时弹窗自行重现。
  useEffect(() => { setOpenRunId(null); }, [selectedId]);

  const selected = schedules.find((item) => item.id === selectedId) ?? null;
  const activeCount = schedules.filter((item) => item.status === "active").length;
  // 轮询会替换 detail 对象，只有切换任务（id 不一致）时才让详情短暂进入加载态。
  const currentDetail = detail && detail.schedule.id === selectedId ? detail : null;
  // 结果弹窗按 id 取最新记录，轮询刷新时窗口内的状态和结果会跟着更新。
  const openRun = openRunId
    ? currentDetail?.runs.find((run) => run.id === openRunId) ?? null
    : null;
  const leadAgents = useMemo(
    () => agents.filter((agent) => agent.mode !== "subagent"),
    [agents],
  );
  const otherAgents = useMemo(
    () => agents.filter((agent) => agent.mode !== "primary" && agent.key !== form?.leadAgentKey),
    [agents, form?.leadAgentKey],
  );
  const agentName = useCallback(
    (key: string) => agents.find((agent) => agent.key === key)?.name ?? key,
    [agents],
  );

  const act = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      await refresh(selectedId);
      setNotice({ tone: "success", text: success });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "操作失败" });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = form.id
        ? await updateSchedule(form.id, inputOf(form))
        : await createSchedule(inputOf(form));
      setForm(null);
      await refresh(result.schedule.id);
      setNotice({ tone: "success", text: form.id ? "任务已更新" : "任务已创建" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedSchedule = async (schedule: ScheduleSummary) => {
    const confirmed = await confirmDialog({
      title: `删除定时任务「${schedule.name}」`,
      description: "任务配置及其执行记录将从定时任务页删除，且无法恢复。已生成的对话和文件会保留。",
      confirmLabel: "删除任务",
      variant: "danger",
    });
    if (!confirmed) return;

    const nextId = schedules.find((item) => item.id !== schedule.id)?.id ?? null;
    setBusy(true);
    setNotice(null);
    try {
      await deleteSchedule(schedule.id);
      setSelectedId(nextId);
      setDetail(null);
      await refresh(nextId);
      setNotice({ tone: "success", text: "任务已删除" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "删除失败" });
    } finally {
      setBusy(false);
    }
  };

  const detailPane = (
    <aside className="schedule-detail" aria-label="任务详情">
      <div className="schedule-detail-inner">
        {!selected ? (
          <div className="schedule-onboarding">
            <span className="schedule-onboarding-icon" aria-hidden="true"><IconClock /></span>
            <h2>选择左侧任务查看详情</h2>
            <p>任务列表会随窗口宽度自动排布；点开任意任务即可查看执行安排和历史记录。</p>
          </div>
        ) : !currentDetail ? (
          <div className="schedule-loading" role="status">
            <span className="schedule-spinner" aria-hidden="true" />正在读取任务详情…
          </div>
        ) : (
          <>
            <div className="schedule-detail-head">
              <div>
                <h2 className="schedule-detail-title">{selected.name}</h2>
                <div className="schedule-detail-rule">{ruleLabel(selected)} · Asia/Shanghai</div>
              </div>
              <span className={`schedule-status ${selected.status}`}>{statusLabels[selected.status]}</span>
            </div>
            {selected.statusReason ? <div className="schedule-reason">{selected.statusReason}</div> : null}
            <div className="schedule-detail-actions">
              <button className="button" disabled={busy || !selected.canRunNow} onClick={() => void act(() => runSchedule(selected.id, clientId()), "已加入个人执行队列")}>立即运行</button>
              {selected.status === "active" ? (
                <button className="button-secondary" disabled={busy} onClick={() => void act(() => pauseSchedule(selected.id), "任务已暂停")}>暂停</button>
              ) : selected.status === "paused" ? (
                <button className="button-secondary" disabled={busy || !selected.canResume} onClick={() => void act(() => resumeSchedule(selected.id), "任务已恢复")}>恢复</button>
              ) : null}
              <button className="button-secondary" disabled={busy} onClick={() => setForm(scheduleForm(selected))}>编辑</button>
              <button className="button-danger" disabled={busy} onClick={() => void deleteSelectedSchedule(selected)}>删除</button>
            </div>
            <div className="schedule-section-label">任务说明</div>
            <div className="schedule-prompt">{selected.prompt}</div>
            <div className="schedule-section-label">执行安排</div>
            <dl className="schedule-meta">
              <div><dt>主智能体</dt><dd>{agentName(selected.leadAgentKey)}</dd></div>
              <div><dt>协作智能体</dt><dd>{selected.participantAgentKeys.length ? selected.participantAgentKeys.map(agentName).join("、") : "按需使用已分配智能体"}</dd></div>
              <div><dt>输入文件</dt><dd>{selected.attachments.length ? selected.attachments.map((item) => item.filename).join("、") : "无"}</dd></div>
              <div><dt>自动授权</dt><dd>{selected.autoApprovePermissions ? "开启，仅允许本次请求" : "关闭"}</dd></div>
              <div><dt>下次执行</dt><dd>{selected.status === "paused" ? "已暂停，恢复后重新计算" : formatShanghaiDateTime(selected.nextRunAt)}</dd></div>
            </dl>
            <div className="schedule-runs-head">执行记录<span>{currentDetail.runs.length} 条</span></div>
            <div className="schedule-runs">
              {currentDetail.runs.length === 0
                ? <div className="schedule-empty compact">还没有执行记录</div>
                : currentDetail.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    agentName={agentName}
                    onOpenResult={() => setOpenRunId(run.id)}
                  />
                ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="schedule-page">
      <section className="schedule-surface">
        <header className="schedule-surface-head">
          <div className="schedule-surface-title">
            <h2>全部任务</h2>
            <span className="schedule-surface-count">
              {loading ? "正在读取…" : (
                <>共 <strong>{schedules.length}</strong> 个任务{activeCount > 0 ? <> · <strong>{activeCount}</strong> 个运行中</> : null}</>
              )}
            </span>
          </div>
          {loading || schedules.length > 0 ? (
            <button
              className="button"
              type="button"
              disabled={agents.length === 0 || loading}
              onClick={() => setForm(emptyForm(agents, defaultModel))}
            >
              <IconPlus />新建任务
            </button>
          ) : null}
        </header>

        {notice ? (
          <div className={`schedule-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}
          </div>
        ) : null}

        {!loading && agents.length === 0 ? (
          <div className="schedule-notice warning">管理员尚未给你分配可用智能体。历史记录仍可查看。</div>
        ) : null}

        {loading ? (
          <div className="schedule-body" aria-busy="true">
            <div className="schedule-panels" aria-hidden="true">
              {[0, 1, 2, 3].map((key) => <div className="schedule-skeleton" key={key} />)}
            </div>
            <aside className="schedule-detail" aria-label="任务详情">
              <div className="schedule-loading" role="status">
                <span className="schedule-spinner" aria-hidden="true" />正在读取定时任务…
              </div>
            </aside>
          </div>
        ) : schedules.length === 0 ? (
          <div className="schedule-body schedule-body-empty">
            <div className="schedule-onboarding">
              <span className="schedule-onboarding-icon" aria-hidden="true"><IconClock /></span>
              <h2>还没有定时任务</h2>
              <p>定时任务按北京时间自动执行，支持一次、每天、每周和 Crontab 自定义频率。</p>
              <div className="schedule-onboarding-actions">
                <button
                  className="button"
                  type="button"
                  disabled={agents.length === 0}
                  onClick={() => setForm(emptyForm(agents, defaultModel))}
                >
                  <IconPlus />新建定时任务
                </button>
                <Link className="button-secondary" href="/chat">在对话中创建</Link>
              </div>
            </div>
          </div>
        ) : (
          <div className="schedule-body">
            <div className="schedule-panels" role="group" aria-label="定时任务列表">
              {schedules.map((schedule) => (
                <button
                  key={schedule.id}
                  type="button"
                  className={`schedule-panel${schedule.id === selectedId ? " active" : ""}`}
                  aria-pressed={schedule.id === selectedId}
                  onClick={() => void refresh(schedule.id)}
                >
                  <span className="schedule-panel-head">
                    <span className="schedule-panel-name" title={schedule.name}>{schedule.name}</span>
                    <span className={`schedule-status ${schedule.status}`}>{statusLabels[schedule.status]}</span>
                  </span>
                  <span className="schedule-panel-rule">
                    <IconClock />
                    {ruleLabel(schedule)}
                  </span>
                  <span className="schedule-panel-prompt">{schedule.prompt}</span>
                  <span className="schedule-panel-foot">
                    <span className="schedule-panel-next">
                      {schedule.status === "paused" ? "已暂停，恢复后重新计算" : schedule.nextRunAt ? `下次 ${formatShanghaiDateTime(schedule.nextRunAt)}` : "暂无后续执行"}
                    </span>
                    <span className="schedule-panel-agent">{agentName(schedule.leadAgentKey)}</span>
                  </span>
                </button>
              ))}
            </div>
            {detailPane}
          </div>
        )}

        <footer className="schedule-surface-foot">
          定时任务按北京时间（Asia/Shanghai）执行，关闭页面后仍会按计划触发。
        </footer>
      </section>

      {openRun ? (
        <RunResultDialog
          key={openRun.id}
          run={openRun}
          scheduleId={selectedId ?? ""}
          agentName={agentName}
          onClose={() => setOpenRunId(null)}
        />
      ) : null}

      {form ? (
        <ScheduleDialog
          form={form}
          setForm={setForm}
          agents={leadAgents}
          otherAgents={otherAgents}
          models={models}
          busy={busy}
          onSave={() => void save()}
          onClose={() => setForm(null)}
        />
      ) : null}
    </div>
  );
}

function RunRow({
  run,
  agentName,
  onOpenResult,
}: {
  run: ScheduleRunSummary;
  agentName: (key: string) => string;
  onOpenResult: () => void;
}) {
  const execution = run.execution;
  const reason = run.skipReason ?? execution?.error;
  return (
    <article className={`schedule-run ${run.decision === "skipped" ? "skipped" : execution?.status ?? "queued"}`}>
      <div className="schedule-run-main">
        <div>
          <strong>{runStatus(run)}</strong>
          <span>{triggerLabel(run)} · {formatShanghaiDateTime(run.scheduledFor)}</span>
        </div>
        {run.execution ? (
          <button type="button" className="schedule-run-action" onClick={onOpenResult}>查看结果</button>
        ) : null}
      </div>
      {execution ? (
        <div className="schedule-run-times">
          实际开始：{formatShanghaiDateTime(execution.startedAt)} · 结束：{formatShanghaiDateTime(execution.finishedAt)}
        </div>
      ) : null}
      {reason ? <p className="schedule-run-reason">{reason}</p> : null}
      {execution?.outputFiles.length ? (
        <div className="schedule-run-files">
          输出文件：{execution.outputFiles.map((file) => (
            <Link key={file.path} href={`/files?path=${encodeURIComponent(file.path)}`}>{file.filename}</Link>
          ))}
        </div>
      ) : null}
      <div className="schedule-run-agents">
        计划所需：{run.plannedAgentKeys.map(agentName).join("、") || "无"}
        {execution?.actualAgentKeys.length ? ` · 实际协作：${execution.actualAgentKeys.map(agentName).join("、")}` : ""}
      </div>
    </article>
  );
}

function RunResultDialog({
  run,
  scheduleId,
  agentName,
  onClose,
}: {
  run: ScheduleRunSummary;
  scheduleId: string;
  agentName: (key: string) => string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, ".schedule-dialog-close");
  const execution = run.execution;
  const executionId = execution?.id ?? null;
  const executionStatus = execution?.status ?? null;
  // 历史记录里保存的结果摘要可能包含推理内容，打开弹窗时按对话页的规则重新读取模型回答。
  const [answer, setAnswer] = useState<string | null>(null);
  useEffect(() => {
    if (!executionId || !scheduleId) return;
    let cancelled = false;
    void getScheduleRunAnswer(scheduleId, run.id)
      .then((response) => {
        if (!cancelled) setAnswer(response.answer?.trim() ? response.answer : null);
      })
      .catch(() => {
        if (!cancelled) setAnswer(null);
      });
    return () => { cancelled = true; };
  }, [executionId, executionStatus, run.id, scheduleId]);
  const result = (answer ?? execution?.resultSummary?.trim() ?? "").trim();
  const reason = run.skipReason ?? execution?.error ?? null;
  return (
    <div
      className="schedule-dialog-backdrop"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        ref={dialogRef}
        className="schedule-dialog schedule-result-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-result-title"
        onKeyDown={(event) => dialogKeyDown(event, dialogRef.current, onClose)}
      >
        <header>
          <div>
            <h2 id="schedule-result-title">执行结果</h2>
            <p>{runStatus(run)} · {triggerLabel(run)} · {formatShanghaiDateTime(run.scheduledFor)}</p>
          </div>
          <button type="button" className="schedule-dialog-close" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="schedule-result-body">
          {reason ? <div className="schedule-result-reason">{reason}</div> : null}
          {result ? (
            <div
              className="schedule-result-text opshelper-markdown"
              dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(result) }}
            />
          ) : (
            <p className="schedule-result-empty">
              {runResultEmptyText[execution?.status ?? "queued"]}
            </p>
          )}
          {execution?.outputFiles.length ? (
            <div className="schedule-result-files">
              <span>输出文件</span>
              {execution.outputFiles.map((file) => (
                <Link key={file.path} href={`/files?path=${encodeURIComponent(file.path)}`}>{file.filename}</Link>
              ))}
            </div>
          ) : null}
          {execution ? (
            <dl className="schedule-meta schedule-result-meta">
              <div><dt>实际开始</dt><dd>{formatShanghaiDateTime(execution.startedAt)}</dd></div>
              <div><dt>结束</dt><dd>{formatShanghaiDateTime(execution.finishedAt)}</dd></div>
              <div><dt>计划所需智能体</dt><dd>{run.plannedAgentKeys.map(agentName).join("、") || "无"}</dd></div>
              <div>
                <dt>实际协作</dt>
                <dd>{execution.actualAgentKeys.length ? execution.actualAgentKeys.map(agentName).join("、") : "未记录"}</dd>
              </div>
            </dl>
          ) : null}
        </div>
        <footer>
          {run.conversationId ? (
            <Link
              className="button-secondary"
              href={`/chat?conversation=${encodeURIComponent(run.conversationId)}`}
            >
              打开完整对话
            </Link>
          ) : null}
          <button type="button" className="button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}

function ScheduleDialog({
  form,
  setForm,
  agents,
  otherAgents,
  models,
  busy,
  onSave,
  onClose,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState | null>>;
  agents: ConversationAgent[];
  otherAgents: ConversationAgent[];
  models: ChatModelOption[];
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const [pickFiles, setPickFiles] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, "input");
  const patch = (value: Partial<FormState>) => setForm((current) => current ? { ...current, ...value } : current);
  return (
    <div className="schedule-dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" onKeyDown={(event) => dialogKeyDown(event, dialogRef.current, onClose, !busy)}>
        <header>
          <div>
            <h2 id="schedule-dialog-title">{form.id ? "编辑定时任务" : "新建定时任务"}</h2>
            <p>所有任务按北京时间执行。</p>
          </div>
          <button type="button" className="schedule-dialog-close" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="schedule-form">
          <label><span>任务名称</span><input value={form.name} maxLength={120} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：每日入口健康检查" /></label>
          <label>
            <span>任务说明</span>
            <textarea value={form.prompt} onChange={(event) => patch({ prompt: event.target.value })} placeholder="写清目标、范围和期望输出，让任务可以独立执行。" />
            <small className="schedule-field-help">如需生成结果文件，请在任务说明中使用 <code>{"{{output_dir}}"}</code> 表示本轮结果目录。</small>
          </label>
          <div className="schedule-form-grid">
            <label><span>主智能体</span><select value={form.leadAgentKey} onChange={(event) => patch({ leadAgentKey: event.target.value, participantAgentKeys: form.participantAgentKeys.filter((key) => key !== event.target.value && otherAgents.some((agent) => agent.key === key)) })}>{agents.map((agent) => <option key={agent.key} value={agent.key}>{agent.name}</option>)}</select></label>
            {models.length ? <label><span>模型</span><select value={form.model} onChange={(event) => patch({ model: event.target.value })}>{models.map((model) => <option key={model.model} value={model.model}>{model.name}</option>)}</select></label> : null}
          </div>
          <fieldset className="schedule-collaborators">
            <legend>所需协作智能体</legend>
            {otherAgents.length === 0 ? <span>没有其他已分配智能体</span> : otherAgents.map((agent) => (
              <label key={agent.key}>
                <input type="checkbox" checked={form.participantAgentKeys.includes(agent.key)} onChange={(event) => patch({ participantAgentKeys: event.target.checked ? [...form.participantAgentKeys, agent.key] : form.participantAgentKeys.filter((key) => key !== agent.key) })} />
                {agent.name}
              </label>
            ))}
          </fieldset>
          <label className="schedule-auto-approve">
            <input
              type="checkbox"
              checked={form.autoApprovePermissions}
              onChange={(event) => patch({ autoApprovePermissions: event.target.checked })}
            />
            <span>
              自动允许工具授权
              <small>适合无人值守任务；每次只允许当前请求，智能体提问仍会等待处理。</small>
            </span>
          </label>
          <div className="schedule-file-field">
            <div><span>输入文件</span><small>执行时读取当时内容，并记录文件摘要。</small></div>
            <button type="button" className="button-secondary" onClick={() => setPickFiles((value) => !value)}>{pickFiles ? "收起文件" : "选择文件"}</button>
          </div>
          {form.attachments.length ? <div className="schedule-file-chips">{form.attachments.map((file) => <span key={file.path}>{file.filename}<button type="button" onClick={() => patch({ attachments: form.attachments.filter((item) => item.path !== file.path) })}>×</button></span>)}</div> : null}
          {pickFiles ? <FilePicker selected={form.attachments} onPick={(file) => patch({ attachments: form.attachments.some((item) => item.path === file.path) ? form.attachments : [...form.attachments, file] })} /> : null}
          <div className="schedule-form-grid schedule-time-grid">
            <label><span>执行频率</span><select value={form.frequency} onChange={(event) => patch({ frequency: event.target.value as FormState["frequency"] })}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="cron">Crontab</option></select></label>
            {form.frequency === "once" ? <label><span>日期</span><input type="date" value={form.localDate} onChange={(event) => patch({ localDate: event.target.value })} /></label> : null}
            {form.frequency === "weekly" ? <label><span>星期</span><select value={form.weekday} onChange={(event) => patch({ weekday: Number(event.target.value) })}>{weekdayLabels.slice(1).map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select></label> : null}
            {form.frequency === "cron" ? (
              <label className="schedule-cron-field">
                <span>Crontab 表达式</span>
                <input value={form.cronExpression} onChange={(event) => patch({ cronExpression: event.target.value })} placeholder="0 9 * * 1-5" spellCheck={false} />
                <small className="schedule-field-help">5 段格式：分 时 日 月 周，例如工作日 09:00 为 <code>0 9 * * 1-5</code>。</small>
              </label>
            ) : <label><span>时间</span><input type="time" value={form.localTime} onChange={(event) => patch({ localTime: event.target.value })} /></label>}
          </div>
        </div>
        <footer><button type="button" className="button-secondary" onClick={onClose}>取消</button><button type="button" className="button" disabled={busy || !form.name.trim() || !form.prompt.trim() || !form.leadAgentKey || (form.frequency === "cron" && !form.cronExpression.trim())} onClick={onSave}>{busy ? "保存中…" : "保存任务"}</button></footer>
      </section>
    </div>
  );
}

function FilePicker({ selected, onPick }: { selected: ConversationAttachment[]; onPick: (file: ConversationAttachment) => void }) {
  const [path, setPath] = useState(rootPath);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/v1/users/me/files/list?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { files?: FileInfo[]; message?: string } | null;
        if (!response.ok) throw new Error(payload?.message ?? "文件读取失败");
        if (!cancelled) setFiles(payload?.files ?? []);
      })
      .catch((value) => { if (!cancelled) setError(value instanceof Error ? value.message : "文件读取失败"); });
    return () => { cancelled = true; };
  }, [path]);
  return (
    <div className="schedule-file-picker">
      <div className="schedule-file-picker-head"><button type="button" disabled={path === rootPath} onClick={() => setPath(parentPath(path))}>返回上级</button><span>{path.replace(/^\/workspace\/?/, "我的文件 / ")}</span><Link href="/files">管理文件</Link></div>
      {error ? <div className="schedule-run-reason">{error}</div> : null}
      {files.map((file) => file.type === "directory" ? (
        <button className="schedule-file-row" type="button" key={file.path} onClick={() => setPath(file.path)}><span>📁 {file.name}</span><small>打开</small></button>
      ) : (
        <button className="schedule-file-row" type="button" key={file.path} disabled={selected.some((item) => item.path === file.path)} onClick={() => onPick({ path: file.path, filename: file.name, mime: guessMime(file.name) })}><span>{file.name}</span><small>{selected.some((item) => item.path === file.path) ? "已选择" : "添加"}</small></button>
      ))}
      {!error && files.length === 0 ? <div className="schedule-empty compact">当前目录没有文件</div> : null}
    </div>
  );
}

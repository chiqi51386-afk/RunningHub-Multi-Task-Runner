import { type ThemeId } from "./themes";
import type { AccountState, JobStatus } from "./types";

export const stateLabel: Record<AccountState, string> = {
  UNCHECKED: "未检测",
  SECRET_UNREADABLE: "密钥需重录",
  IDLE: "可用", BUSY: "执行中", REMOTE_BUSY: "远端忙碌", CHECKING: "检测中",
  COOLDOWN: "冷却中", NO_BALANCE: "余额不足", INVALID_KEY: "密钥无效",
  TEMP_UNAVAILABLE: "暂不可用", DISABLED: "已停用",
};

export const statusLabel: Record<JobStatus, string> = {
  OPTIMIZE_PENDING: "等待优化", OPTIMIZING: "优化中",
  PENDING: "等待中", ASSIGNED: "已分配", UPLOADING: "上传中", SUBMITTING: "提交中",
  SUBMIT_UNKNOWN: "提交状态未知", REMOTE_QUEUED: "远端排队", RUNNING: "生成中",
  REMOTE_SUCCESS: "生成完成", DOWNLOAD_PENDING: "待下载", DOWNLOADING: "下载中",
  COMPLETED: "已完成", FAILED: "失败", RETRY_WAIT: "等待重试", CANCELLED: "已取消",
};

export const terminalJobStatuses = new Set<JobStatus>(["COMPLETED", "FAILED", "CANCELLED", "SUBMIT_UNKNOWN"]);
export const activeJobStatuses = new Set<JobStatus>(["OPTIMIZE_PENDING", "OPTIMIZING", "ASSIGNED", "UPLOADING", "SUBMITTING", "REMOTE_QUEUED", "RUNNING", "REMOTE_SUCCESS", "DOWNLOAD_PENDING", "DOWNLOADING", "RETRY_WAIT"]);

export interface UiPreferences {
  notificationDurationMs: number;
  notificationSound: boolean;
  theme: ThemeId;
}

export const defaultUiPreferences: UiPreferences = { notificationDurationMs: 5_000, notificationSound: true, theme: "dark" };


export function localizedFailureReason(error?: string, status?: JobStatus): string {
  if (status === "SUBMIT_UNKNOWN") return "提交请求的响应丢失，无法确认远端是否已经接收。为避免重复扣费，系统没有自动重发。";
  if (!error) return "远端任务失败，但接口没有返回具体原因。";
  if (/^\s*(?:\{\}|\[\]|null|undefined|\[object Object\])\s*$/i.test(error)) return status === "FAILED" ? "任务失败，接口没有返回可读的错误详情。" : "任务状态查询暂时失败，请查看当前任务状态。";
  if (/NODE_INFO_MISMATCH|field_not_found/i.test(error)) return "工作流节点或字段映射不匹配，请重新导入当前版本的 API JSON。";
  if (/required_input_missing|Required input is missing/i.test(error)) return "工作流缺少必填输入，请检查图片、音频、视频或提示词是否已经上传。";
  if (/prompt_outputs_failed_validation|failed validation/i.test(error)) return "工作流参数校验失败，请检查必填输入和节点开关。";
  if (/insufficient|balance|余额|coins?/i.test(error)) return "账号余额不足，无法继续生成。";
  if (/timeout|timed out|超时/i.test(error)) return "请求或下载超时，请检查网络后重试。";
  if (/unauthorized|invalid.*key|401|403|密钥|API Key/i.test(error)) return "API Key 无效或没有权限，请重新检测账号。";
  if (/cancel/i.test(error)) return "任务已被取消。";
  if (/[一-鿿]/.test(error)) return error;
  return `远端返回错误：${error}`;
}

export function playNotificationSound(tone: "success" | "error") {
  try {
    const context = new AudioContext();
    const notes = tone === "success" ? [660, 880] : [330, 220];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * .14;
      oscillator.type = tone === "success" ? "sine" : "triangle";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(.09, start + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + .2);
    });
    window.setTimeout(() => void context.close(), 700);
  } catch { /* Audio is optional when the system has no output device. */ }
}

export function isTerminalJobStatus(status: JobStatus) {
  return terminalJobStatuses.has(status);
}

export function relativeTime(time?: number) {
  if (!time) return "从未";
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function StatusPill({ status }: { status: JobStatus }) {
  const active = activeJobStatuses.has(status);
  return <span className={`status status-${status.toLowerCase()}`}>{active && <span className="pulse-dot" />}{statusLabel[status]}</span>;
}

export function AccountPill({ state, remoteTaskCount }: { state: AccountState; remoteTaskCount?: number }) {
  const label = state === "REMOTE_BUSY" && remoteTaskCount
    ? `远端任务 ${remoteTaskCount}`
    : stateLabel[state];
  return <span className={`account-state account-${state.toLowerCase()}`} title={state === "REMOTE_BUSY" ? "RunningHub 返回该 API Key 当前有远端任务，任务结束后会自动复查" : undefined}><span />{label}</span>;
}

export function PageHeading({ title, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1></div>{action}</div>;
}

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RunningHubConfig } from "../types.js";
import { classifyRunningHubError, RunningHubError } from "../runninghub/errors.js";

interface ResumeInfo { url: string; validator: string; total: number }

export async function downloadFile(fetchImpl: typeof fetch, config: RunningHubConfig, url: string, destination: string, signal?: AbortSignal): Promise<string> {
  const temp = `${destination}.part`;
  const metadata = `${temp}.json`;
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("下载连接长时间未收到数据（Download idle timeout），将自动重试。")), config.downloadTimeoutMs);
  };
  const discard = async () => { await unlink(temp).catch(() => undefined); await unlink(metadata).catch(() => undefined); };
  let resume: ResumeInfo | undefined;
  let offset = 0;
  let canResume = false;
  try {
    requestSignal.throwIfAborted();
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(metadata, "utf8")) as ResumeInfo;
      const size = (await stat(temp)).size;
      if (saved.url === url && typeof saved.validator === "string" && saved.validator && Number.isSafeInteger(saved.total) && size > 0 && size <= saved.total) {
        resume = saved; offset = size; canResume = true;
      }
    } catch { /* Old partial files without an identity cannot safely be appended. */ }
    requestSignal.throwIfAborted();
    touch();
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (resume) { headers.Range = `bytes=${offset}-`; headers["If-Range"] = resume.validator; }
    let response = await fetchImpl(url, { headers, signal: requestSignal, redirect: "follow" });
    // A changed object or a server rejecting ranges must start a clean transfer.
    if (response.status === 416 && resume) {
      await response.body?.cancel();
      await discard(); resume = undefined; offset = 0; canResume = false;
      touch();
      response = await fetchImpl(url, { headers: { "Accept-Encoding": "identity" }, signal: requestSignal, redirect: "follow" });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      const detail = classifyRunningHubError({ message: `下载服务器返回 HTTP ${response.status}`, httpStatus: response.status, phase: "download" });
      throw new RunningHubError(detail.message, detail);
    }
    touch();
    const encoding = response.headers.get("content-encoding");
    const etag = response.headers.get("etag");
    const validator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified") ?? "";
    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null ? undefined : Number(lengthHeader);
    let total: number | undefined;
    let append = false;
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
      if (!resume || !range || Number(range[1]) !== offset || Number(range[2]) !== Number(range[3]) - 1 || Number(range[3]) !== resume.total || validator !== resume.validator || (encoding && encoding !== "identity") || (length !== undefined && length !== Number(range[2]) - offset + 1)) {
        await response.body.cancel(); await discard(); canResume = false;
        throw new Error("下载续传响应不匹配，已清除不一致的片段，将重新下载。");
      }
      total = resume.total; append = true;
    } else if (response.status === 200) {
      offset = 0; canResume = false;
      await discard();
      if (!encoding || encoding === "identity") total = length;
      if (validator && total !== undefined && Number.isSafeInteger(total) && total > 0) {
        await writeFile(metadata, JSON.stringify({ url, validator, total } satisfies ResumeInfo), "utf8");
        canResume = true;
      }
    } else {
      await response.body.cancel();
      throw new Error(`不支持的下载响应 HTTP ${response.status}`);
    }
    let received = offset;
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length; touch(); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as never), progress, createWriteStream(temp, { flags: append ? "a" : "w" }), { signal: requestSignal });
    requestSignal.throwIfAborted();
    if (total !== undefined && received !== total) throw new Error(`下载文件不完整：${received}/${total} 字节，将自动重试。`);
    clearTimeout(timer);
    await rename(temp, destination);
    await unlink(metadata).catch(() => undefined);
    return destination;
  } catch (error) {
    const cancelled = signal?.aborted && /cancelled by user/i.test(String(signal.reason));
    if (!canResume || cancelled) await discard();
    if (error instanceof RunningHubError) throw error;
    const detail = classifyRunningHubError({ message: controller.signal.aborted ? controller.signal.reason : error, phase: "download" });
    throw new RunningHubError(detail.message, detail, error);
  } finally { clearTimeout(timer); }
}

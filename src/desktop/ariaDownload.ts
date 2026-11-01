import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { downloadFile, publishWithoutOverwrite } from "../core/downloads/transfer.js";

// aria2 handles segmentation and resume. The loopback relay retains Electron's
// explicit proxy/TLS/redirect handling (including SOCKS), without sharing secrets
// or opening a general-purpose proxy. No RPC service or shell is used.
export function ariaDownload(binary: string): typeof downloadFile {
  return async (fetchImpl, config, url, destination, signal) => {
    signal?.throwIfAborted();
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("下载仅支持 HTTP / HTTPS");
    try { await access(binary); } catch { return downloadFile(fetchImpl, config, url, destination, signal); }
    const identity = createHash("sha256").update(url).digest("hex").slice(0, 24);
    const temp = `${destination}.${identity}.aria-part`;
    const control = `${temp}.aria2`;
    await mkdir(path.dirname(destination), { recursive: true });
    // Without an aria2 control file an interrupted file is not a valid resume.
    if (!(await access(control).then(() => true, () => false))) await unlink(temp).catch(() => undefined);
    const lifecycle = new AbortController();
    const token = `/${randomUUID()}`;
    const relay = createServer(async (request, response) => {
      if (request.url !== token || !["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(404).end(); return; }
      const controller = new AbortController();
      response.on("close", () => controller.abort());
      const requestSignal = AbortSignal.any([lifecycle.signal, controller.signal, ...(signal ? [signal] : [])]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), config.downloadTimeoutMs); };
      try {
        touch();
        const headers: Record<string, string> = { "Accept-Encoding": "identity" };
        for (const name of ["range", "if-range", "if-match", "if-unmodified-since"]) {
          const value = request.headers[name]; if (typeof value === "string") headers[name] = value;
        }
        const upstream = await fetchImpl(url, { method: request.method, headers, signal: requestSignal, redirect: "follow" });
        response.statusCode = upstream.status;
        for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified", "content-type"]) {
          const value = upstream.headers.get(name); if (value !== null) response.setHeader(name, value);
        }
        if (!upstream.body || request.method === "HEAD") { await upstream.body?.cancel(); response.end(); return; }
        const stream = Readable.fromWeb(upstream.body as never);
        stream.on("data", touch);
        await pipeline(stream, response, { signal: requestSignal });
      } catch {
        if (!response.headersSent) response.writeHead(502);
        response.destroy();
      } finally { clearTimeout(timer); }
    });
    await new Promise<void>((resolve, reject) => { relay.once("error", reject); relay.listen(0, "127.0.0.1", resolve); });
    let completed = false;
    try {
      const port = (relay.address() as AddressInfo).port;
      const args = ["--no-conf=true", "--enable-rpc=false", "--continue=true", "--auto-file-renaming=false", "--allow-overwrite=true",
        "--follow-metalink=false", "--follow-torrent=false", "--enable-dht=false", "--enable-peer-exchange=false",
        "--file-allocation=none", "--split=4", "--max-connection-per-server=4", "--min-split-size=4M",
        "--max-tries=3", "--retry-wait=2", "--connect-timeout=20", `--timeout=${Math.max(30, Math.ceil(config.downloadTimeoutMs / 1000))}`,
        "--auto-save-interval=1", "--summary-interval=0", "--console-log-level=error", "--download-result=hide",
        "--check-certificate=true", "--all-proxy=", "--http-proxy=", "--https-proxy=",
        `--dir=${path.dirname(temp)}`, `--out=${path.basename(temp)}`, `http://127.0.0.1:${port}${token}`];
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: "ignore", env });
        const abort = () => child.kill();
        signal?.addEventListener("abort", abort, { once: true });
        child.once("error", error => { signal?.removeEventListener("abort", abort); reject(error); });
        child.once("close", value => { signal?.removeEventListener("abort", abort); resolve(value); });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      completed = code === 0 && (await stat(temp)).isFile() && !(await access(control).then(() => true, () => false));
    } catch { signal?.throwIfAborted(); }
    finally {
      lifecycle.abort(); relay.closeAllConnections();
      await new Promise<void>(resolve => relay.close(() => resolve()));
      if (signal?.aborted && /cancelled by user/i.test(String(signal.reason))) {
        await unlink(temp).catch(() => undefined); await unlink(control).catch(() => undefined);
      }
    }
    signal?.throwIfAborted();
    if (completed) {
      const result = await publishWithoutOverwrite(temp, destination);
      // Only retire legacy resume data belonging to this exact remote object,
      // and only after the completed file has been successfully published.
      try {
        const metadata = `${destination}.part.json`;
        const saved = JSON.parse(await readFile(metadata, "utf8"));
        if (saved.url === url) {
          await unlink(`${destination}.part`).catch(error => { if (error.code !== "ENOENT") throw error; });
          await unlink(metadata);
        }
      } catch { /* Cleanup failure must not turn a completed download into a retry. */ }
      return result;
    }
    const result = await downloadFile(fetchImpl, config, url, destination, signal);
    await unlink(temp).catch(() => undefined); await unlink(control).catch(() => undefined);
    return result;
  };
}

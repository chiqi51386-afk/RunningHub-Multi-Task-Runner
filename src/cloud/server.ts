import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
import { importAccounts } from "../core/accounts/portable.js";
import { parseJobResult } from "../core/runninghub/client.js";
import { stereoWav } from "../core/gemini/stereoWav.js";
import { TTS_LANGUAGES, TTS_VOICES } from "../core/gemini/ttsTypes.js";
import { validateTtsInput } from "../core/gemini/tts.js";
import type { CloudRuntime } from "./runtime.js";

async function jsonBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function cloudServer(runtime: CloudRuntime, token: string) {
  const { backend, gemini, skills, root } = runtime;
  const ttsActive = new Map<string, AbortController>();
  const ttsPending = new Set<Promise<void>>();
  backend.database.raw.exec("CREATE TABLE IF NOT EXISTS cloud_tts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, file TEXT)");
  backend.database.raw.prepare("UPDATE cloud_tts SET state='interrupted' WHERE state='processing'").run();
  const authorized = (value: string | undefined) => {
    const a = Buffer.from(value ?? ""), b = Buffer.from(`Bearer ${token}`);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!authorized(request.headers.authorization) || request.headers.origin) { response.writeHead(401).end(); return; }
    const url = new URL(request.url ?? "/", "http://localhost"), parts = url.pathname.split("/").filter(Boolean);
    const method = request.method, [resource, id, action, index] = parts;
    const send = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); };
    const sendFile = async (file: string) => {
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
      await pipeline(createReadStream(file), response);
    };
    try {
      if (method === "GET" && resource === "health") return send({ ready: true, scheduler: backend.scheduler.isRunning() });
      if (method === "POST" && resource === "uploads") {
        const extension = path.extname(url.searchParams.get("filename") ?? "").toLowerCase();
        if (!/^\.(jpg|jpeg|png|webp|wav|mp3|aac|flac|ogg|m4a|mp4|mov|webm)$/.test(extension)) throw new Error("Unsupported media extension");
        const file = path.join(root, "uploads", randomUUID() + extension); let size = 0;
        const limit = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; done(size > 2 * 1024 ** 3 ? new Error("Media exceeds 2 GB") : null, chunk); } });
        try { await pipeline(request, limit, createWriteStream(file, { flags: "wx", mode: 0o600 })); }
        catch (error) { await rm(file, { force: true }); throw error; }
        return send({ localPath: file, bytes: size });
      }
      if (resource === "accounts") {
        if (method === "GET") return send({ runninghub: backend.accounts.list(), gemini: gemini.store.settings() });
        const body = await jsonBody(request);
        if (method === "POST" && id === "import") {
          const result = importAccounts(backend.database, gemini.store, body);
          void backend.scheduler.schedule();
          // Detection is separate and explicit; importing does not submit anything.
          return send(result);
        }
        if (method === "POST" && id === "runninghub") return send(backend.accounts.add(body.label, body.apiKey));
        if (method === "POST" && id === "gemini") return send(gemini.store.add(body.keys));
        if (method === "POST" && id && action === "test") return send(await backend.accounts.refresh(id));
        if (method === "POST" && id === "test-all") return send(await backend.accounts.refreshAll());
        if (method === "PATCH" && id) {
          if (body.maxConcurrency !== undefined) backend.accounts.setConcurrency(id, body.maxConcurrency);
          if (body.preferred !== undefined) backend.accounts.setPriority(id, body.preferred);
          if (typeof body.enabled === "boolean") body.enabled ? backend.accounts.enable(id) : backend.accounts.disable(id);
          return send(backend.accounts.get(id));
        }
        if (method === "DELETE" && id) return send({ removed: backend.accounts.remove(id) });
      }
      if (resource === "gemini" && method === "POST") {
        const body = await jsonBody(request);
        if (id === "model") return send(gemini.store.setModel(body.model));
        if (id === "test") return send(await gemini.test(body.id));
        if (id === "enabled") return send(gemini.store.setEnabled(body.id, body.enabled));
        if (id === "remove") return send(gemini.store.remove(body.id));
      }
      if (resource === "workflows") {
        if (method === "GET") return send(id ? backend.workflows.get(id) : backend.workflows.list());
        if (method === "DELETE" && id) return send({ removed: backend.workflows.remove(id) });
        const body = await jsonBody(request);
        if (method === "POST" && id === "import") return send(backend.workflows.importPortablePackage(body));
        if (method === "POST" && id === "import-api") return send(backend.workflows.importApiJson(body));
        if (method === "PATCH" && id) return send(backend.workflows.updateProfile(id, body.profile, body.metadata));
      }
      if (resource === "skills" && id) {
        if (method === "GET") return send(skills.settings(id));
        const body = await jsonBody(request);
        if (method === "POST" && action === "import") return send(skills.import(id, body.name, body.content));
        if (method === "POST" && action === "select") return send(skills.select(id, body.skillId));
      }
      if (resource === "jobs") {
        if (method === "GET" && action === "files" && id) {
          const file = backend.jobs.get(id)?.outputs?.files[Number(index)]?.localPath;
          if (!file) throw new Error("File is not downloaded yet");
          return await sendFile(file);
        }
        if (method === "GET") {
          const jobs = backend.jobs.list(), query = (url.searchParams.get("search") ?? "").toLowerCase();
          return send(id ? backend.jobs.get(id) : jobs.filter(j => !query || [j.id,j.remoteTaskId,j.profileSnapshot.taskName,...Object.values(j.parameters)].join(" ").toLowerCase().includes(query)));
        }
        if (method === "POST" && !id) {
          const body = await jsonBody(request);
          if (typeof body.requestId !== "string" || !/^[\w-]{1,100}$/.test(body.requestId) || !Array.isArray(body.jobs) || !body.jobs.length || body.jobs.length > 500) throw new Error("requestId and 1–500 jobs required");
          const hash = createHash("sha256").update(JSON.stringify(body.jobs)).digest("hex");
          const existing = () => backend.database.raw.prepare("SELECT hash,jobs FROM cloud_requests WHERE id=?").get(body.requestId) as { hash: string; jobs: string } | undefined;
          const replay = (saved: { hash: string; jobs: string }) => {
            if (saved.hash !== hash) throw new Error("requestId already used with different input");
            return { replay: true, jobIds: JSON.parse(saved.jobs) };
          };
          const saved = existing(); if (saved) return send(replay(saved));
          const prepared = await Promise.all(body.jobs.map((job: any) => runtime.prepare(job)));
          const result = backend.database.transaction(() => {
            const raced = existing(); if (raced) return replay(raced);
            const jobs = backend.jobs.createBatch(prepared), jobIds = jobs.map(j => j.id);
            backend.database.raw.prepare("INSERT INTO cloud_requests(id,hash,jobs) VALUES(?,?,?)").run(body.requestId,hash,JSON.stringify(jobIds));
            return { replay: false, jobIds };
          });
          return send(result);
        }
        if (method === "POST" && id && action === "cancel") return send(await backend.scheduler.cancel(id));
        if (method === "POST" && id && action === "retry-download") return send(backend.downloads.retryNow(id));
        if (method === "POST" && id && action === "query") {
          const job = backend.jobs.get(id);
          if (!job?.remoteTaskId || !job.accountId) throw new Error("No original remote task to query");
          const raw = await backend.accounts.clientFor(job.accountId).client.queryTask(job.remoteTaskId);
          // Automatic recovery remains the scheduler's responsibility for active jobs.
          if (["FAILED", "COMPLETED"].includes(job.status)) {
            try { const outputs = parseJobResult(job.remoteTaskId, raw);
              backend.jobs.recoverTransition(id, "DOWNLOAD_PENDING", { outputs, rawResult: raw, lastError: null, completedAt: null });
              backend.downloads.enqueue(id);
            } catch { /* No output yet: retain the same remote task and report its response. */ }
          }
          return send(raw);
        }
        if (method === "DELETE" && id) return send({ removed: backend.jobs.remove(id) });
      }
      if (resource === "tts") {
        if (method === "GET" && !id) return send({ languages: TTS_LANGUAGES, voices: TTS_VOICES });
        if (method === "GET" && id) {
          const saved = backend.database.raw.prepare("SELECT state,file FROM cloud_tts WHERE id=?").get(id) as { state: string; file?: string } | undefined;
          if (action === "audio" && saved?.file) return await sendFile(saved.file);
          return send(saved ?? null);
        }
        if (method === "POST" && id && action === "cancel") { ttsActive.get(id)?.abort(); return send({ cancelled: true }); }
        if (method === "POST" && !id) {
          const body = await jsonBody(request), key = body.requestId;
          if (typeof key !== "string" || !/^[\w-]{1,100}$/.test(key)) throw new Error("requestId required");
          const hash = createHash("sha256").update(JSON.stringify(body.input)).digest("hex");
          const saved = backend.database.raw.prepare("SELECT hash,state,file FROM cloud_tts WHERE id=?").get(key) as { hash: string; state: string; file?: string } | undefined;
          if (saved) { if (saved.hash !== hash) throw new Error("requestId already used"); return send({ requestId: key, state: saved.state, file: saved.file }); }
          if (ttsActive.size >= 2) throw new Error("TTS busy");
          validateTtsInput(body.input);
          backend.database.raw.prepare("INSERT INTO cloud_tts(id,hash,state) VALUES(?,?,'processing')").run(key,hash);
          const controller = new AbortController(); ttsActive.set(key, controller);
          // Persist first; never automatically repeat a billable speech call after interruption.
          const pending = (async () => {
            try {
              const result = await gemini.speech(body.input, controller.signal), file = path.join(root,"tts",`tts-${randomUUID()}.wav`);
              await writeFile(file, stereoWav(Buffer.from(result.text,"base64")), { mode: 0o600 });
              backend.database.raw.prepare("UPDATE cloud_tts SET state='completed',file=? WHERE id=?").run(file,key);
            } catch { backend.database.raw.prepare("UPDATE cloud_tts SET state='failed' WHERE id=?").run(key); }
            finally { ttsActive.delete(key); }
          })();
          ttsPending.add(pending);
          void pending.finally(() => ttsPending.delete(pending));
          return send({ requestId: key, state: "processing" }, 202);
        }
      }
      send({ error: "Unknown endpoint" }, 404);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      // Do not echo raw provider responses/keys to logs.
      send({ error: error instanceof Error ? error.message : "Request failed" }, 400);
    }
  });
  return Object.assign(server, { async stopTts() {
    for (const controller of ttsActive.values()) controller.abort();
    await Promise.allSettled([...ttsPending]);
  } });
}

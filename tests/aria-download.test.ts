import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ariaDownload } from "../src/desktop/ariaDownload.js";
import { resolveConfig } from "../src/core/config.js";

const binary = path.resolve("download-engine/aria2c.exe");
const available = process.platform === "win32" && await access(binary).then(() => true, () => false);
for (const ranged of [true, false]) {
  test(`aria2 downloads identical bytes with range support=${ranged}`, { skip: !available }, async () => {
    const data = Buffer.alloc(24 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    let rangeRequests = 0;
    const server = createServer(async (req, res) => {
      const match = ranged && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : data.length - 1;
      if (match) rangeRequests++;
      res.writeHead(match ? 206 : 200, {
        "Content-Length": end - start + 1, "ETag": '"fixture-v1"',
        ...(ranged ? { "Accept-Ranges": "bytes" } : {}),
        ...(match ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {}),
      });
      if (req.method === "HEAD") { res.end(); return; }
      for (let offset = start; offset <= end && !res.destroyed; offset += 256 * 1024) {
        res.write(data.subarray(offset, Math.min(end + 1, offset + 256 * 1024)));
        await delay(5);
      }
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const dir = await mkdtemp(path.join(tmpdir(), "rh-aria-test-"));
    try {
      const address = server.address() as { port: number };
      const destination = path.join(dir, "video.mp4");
      await writeFile(destination, "existing file");
      const sourceUrl = `http://127.0.0.1:${address.port}/output`;
      await writeFile(`${destination}.part`, "legacy partial");
      await writeFile(`${destination}.part.json`, JSON.stringify({url: sourceUrl}));
      await writeFile(path.join(dir, "other.mp4.part"), "another active download");
      const result = await ariaDownload(binary)(fetch, resolveConfig(), `http://127.0.0.1:${address.port}/output`, destination);
      assert.notEqual(result, destination);
      assert.deepEqual(await readFile(result), data);
      assert.equal(await readFile(destination, "utf8"), "existing file");
      assert.equal(await access(`${destination}.part`).then(() => true, () => false), false);
      assert.equal(await access(`${destination}.part.json`).then(() => true, () => false), false);
      assert.equal(await readFile(path.join(dir, "other.mp4.part"), "utf8"), "another active download");
      if (ranged) assert.ok(rangeRequests >= 2, `expected parallel ranges, got ${rangeRequests}`);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("aria2 cancellation aborts upstream requests and rejects", { skip: !available }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rh-aria-cancel-"));
  const abort = new AbortController();
  const network: typeof fetch = async (_input, init) => {
    abort.abort(new Error("Download cancelled by user"));
    init?.signal?.throwIfAborted();
    throw new Error("cancelled");
  };
  try {
    await assert.rejects(ariaDownload(binary)(network, resolveConfig(), "https://example.com/file", path.join(dir, "video.mp4"), abort.signal), /cancelled by user/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("aria2 resumes a stopped transfer using its control file", { skip: !available }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rh-aria-resume-"));
  const data = Buffer.alloc(32 * 1024 * 1024, 123);
  const starts: number[] = [];
  let slow = true;
  const server = createServer(async (req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : data.length - 1;
    starts.push(start);
    res.writeHead(range ? 206 : 200, {
      "Content-Length": end - start + 1, "ETag": '"resume-test"', "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {}),
    });
    for (let i = start; i <= end && !res.destroyed; i += 64 * 1024) {
      res.write(data.subarray(i, Math.min(i + 64 * 1024, end + 1)));
      await delay(slow ? 30 : 1);
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const destination = path.join(dir, "output.mp4"), url = `http://127.0.0.1:${address.port}/file`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Download queue stopped")), 1600);
  try {
    await assert.rejects(ariaDownload(binary)(fetch, resolveConfig(), url, destination, controller.signal), /queue stopped/);
    assert.ok((await readdir(dir)).some(name => name.endsWith(".aria2")));
    slow = false; starts.length = 0;
    const result = await ariaDownload(binary)(fetch, resolveConfig(), url, destination);
    assert.deepEqual(await readFile(result), data);
    assert.ok(starts.some(start => start > 0));
  } finally {
    clearTimeout(timer); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadFile } from "../src/core/downloads/transfer.js";
import { resolveConfig } from "../src/core/config.js";
const url = "https://cdn.example/video.mp4";
test("existing output is preserved and collisions get a numbered suffix", () => fixture(async file => {
  await writeFile(file, "original");
  await writeFile(file.replace('.mp4', ' (1).mp4'), "other");
  const saved = await downloadFile(async () => new Response("new"), resolveConfig({}), url, file);
  assert.equal(saved, file.replace('.mp4', ' (2).mp4'));
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.equal(await readFile(saved, 'utf8'), 'new');
}));
async function fixture(run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rh-resume-"));
  try { await run(path.join(dir, "video.mp4")); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function partial(file: string) {
  await writeFile(file + ".part", "abc");
  await writeFile(file + ".part.json", JSON.stringify({ url, validator: '"v1"', total: 6 }));
}
test("slow download continues beyond timeout while chunks arrive", () => fixture(async file => {
  let n = 0;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({
    async pull(c) { await new Promise(r => setTimeout(r, 30)); if (n++ < 12) c.enqueue(new TextEncoder().encode("x")); else c.close(); },
  }));
  await downloadFile(fetcher, resolveConfig({ downloadTimeoutMs: 150 }), url, file);
  assert.equal((await readFile(file)).length, 12);
}));
test("idle timeout preserves partial and next request resumes exactly", () => fixture(async file => {
  let sent = false;
  const stalled: typeof fetch = async () => new Response(new ReadableStream({
    pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode("abc")); } },
  }), { headers: { etag: '"v1"', "content-length": "6" } });
  await assert.rejects(downloadFile(stalled, resolveConfig({ downloadTimeoutMs: 150 }), url, file), /idle timeout/);
  assert.equal(await readFile(file + ".part", "utf8"), "abc");
  const resumed: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("range"), "bytes=3-");
    assert.equal(new Headers(init?.headers).get("if-range"), '"v1"');
    return new Response("def", { status: 206, headers: { etag: '"v1"', "content-range": "bytes 3-5/6", "content-length": "3" } });
  };
  await downloadFile(resumed, resolveConfig(), url, file);
  assert.equal(await readFile(file, "utf8"), "abcdef");
  await assert.rejects(access(file + ".part.json"));
}));
test("server ignoring Range replaces rather than appends", () => fixture(async file => {
  await partial(file);
  await downloadFile(async () => new Response("NEWNEW", { headers: { etag: '"v2"', "content-length": "6" } }), resolveConfig(), url, file);
  assert.equal(await readFile(file, "utf8"), "NEWNEW");
}));
test("mismatched range never produces final video", () => fixture(async file => {
  await partial(file);
  await assert.rejects(downloadFile(async () => new Response("def", { status: 206, headers: { etag: '"v1"', "content-range": "bytes 2-4/6" } }), resolveConfig(), url, file), /不匹配/);
  await assert.rejects(access(file)); await assert.rejects(access(file + ".part"));
}));
test("416 restarts cleanly", () => fixture(async file => {
  await partial(file); let calls = 0;
  await downloadFile(async () => ++calls === 1 ? new Response(null, { status: 416 }) : new Response("abcdef"), resolveConfig(), url, file);
  assert.equal(calls, 2); assert.equal(await readFile(file, "utf8"), "abcdef");
}));
test("download HTTP errors retain status and nonretryable classification", () => fixture(async file => {
  await assert.rejects(downloadFile(async () => new Response("denied", { status: 403 }), resolveConfig(), url, file), (e: any) => e.detail.httpStatus === 403 && !e.detail.retryable);
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from '../src/core/runninghub/client.js';
import { resolveConfig } from '../src/core/config.js';

test('interrupted download leaves no final file; retry writes complete data to the selected directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-download-test-'));
  const destination = path.join(root, 'selected', 'MV_001', '001.mp4');
  try {
    const broken: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1,2])); controller.error(new Error('connection interrupted')); },
    }));
    await assert.rejects(downloadFile(broken, resolveConfig(), 'https://cdn.example/video.mp4', destination));
    await assert.rejects(access(destination));
    await assert.rejects(access(destination + '.part'));
    const bytes = new Uint8Array([1,2,3,4,5]);
    assert.equal(await downloadFile(async () => new Response(bytes), resolveConfig(), 'https://cdn.example/video.mp4', destination), destination);
    assert.deepEqual(await readFile(destination), Buffer.from(bytes));
    await assert.rejects(access(destination + '.part'));
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('cancelled download does not replace an existing completed file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-download-test-'));
  const destination = path.join(root, '001.mp4');
  try {
    await downloadFile(async () => new Response('complete'), resolveConfig(), 'https://cdn.example/v.mp4', destination);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(downloadFile(async () => new Response('replacement'), resolveConfig(), 'https://cdn.example/v.mp4', destination, controller.signal));
    assert.equal(await readFile(destination, 'utf8'), 'complete');
  } finally { await rm(root, {recursive:true, force:true}); }
});

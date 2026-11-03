// A finished film's thumbnail is a real frame from late in it (not the empty first frame of a build-up), made
// once and kept next to the render; a wrong key gets nothing. Needs ffmpeg on the PATH.
// Run: node --test server/test/poster.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a film thumbnail is one frame of the render, made once', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-poster-'));
  const jobs = path.join(data, 'jobs');
  const jobId = '20261103120000-abc123';
  const renders = path.join(jobs, jobId, 'project', 'renders');
  fs.mkdirSync(renders, { recursive: true });
  // Black for the first second, then white: a still from the first frame would be black.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=3', '-filter_complex', '[0][1]concat=n=2:v=1', '-pix_fmt', 'yuv420p', path.join(renders, 'final.mp4')]);

  const secret = 'poster-test';
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(here, '..', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: jobs, PUBLIC_API_URL: `http://127.0.0.1:${port}`, JWT_SECRET: secret },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const stopped = new Promise((r) => child.once('exit', r));
  t.after(async () => {
    child.kill();
    await stopped;
    fs.rmSync(data, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const key = crypto.createHmac('sha256', secret).update(`media:${jobId}`).digest('base64url').slice(0, 24);
  const url = `${base}/api/videos/${jobId}/thumbnail.jpg`;
  assert.equal((await fetch(`${url}?k=wrong-key-wrong-key-xxxx`)).status, 404);

  const res = await fetch(`${url}?k=${key}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const jpeg = Buffer.from(await res.arrayBuffer());
  assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
  assert.ok(fs.existsSync(path.join(renders, 'poster.jpg')), 'the still is kept next to the render');

  // The still is the white part of the film, not its black opening.
  const gray = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(renders, 'poster.jpg'), '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-']);
  assert.ok(gray[0] > 200, `expected a white frame, got brightness ${gray[0]}`);
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createAppServer } from './server.mjs';

const servers = [];
const tempDirectories = [];

async function startServer(options = {}) {
  const server = createAppServer(options);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('serves the studio and reports missing OpenAI-compatible server configuration', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'seecut-web-'));
  tempDirectories.push(dataDir);
  const { baseUrl } = await startServer({ dataDir, repoRoot: dataDir });

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SeeCut Studio/);

  const status = await fetch(`${baseUrl}/api/status`).then((response) => response.json());
  assert.equal(status.openai.available, false);
  assert.match(status.openai.reason, /OPENAI_API_KEY/);
});

test('reports a configured local model without exposing its API key', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'seecut-web-'));
  tempDirectories.push(dataDir);
  const { baseUrl } = await startServer({
    dataDir,
    repoRoot: dataDir,
    openAIApiKey: 'test-key-never-return-this',
    openAIBaseUrl: 'http://ai-server.test/v1',
    openAIModel: 'qwen/qwen3.6-35b-a3b',
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer test-key-never-return-this');
      if (url.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }] });
      }
      assert.equal(url, 'http://ai-server.test/api/v0/models');
      return Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b', state: 'loaded', loaded_context_length: 65536 }] });
    },
  });
  const status = await fetch(`${baseUrl}/api/status`).then((response) => response.json());
  assert.equal(status.openai.available, true);
  assert.equal(status.openai.model, 'qwen/qwen3.6-35b-a3b');
  assert.equal(JSON.stringify(status).includes('test-key-never-return-this'), false);
});

test('creates a project and streams an allowed video into its workspace', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'seecut-web-'));
  tempDirectories.push(dataDir);
  const { baseUrl } = await startServer({ dataDir, repoRoot: dataDir });
  const createdResponse = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test cut', prompt: 'Keep the intro short', editMode: 'sample' }),
  });
  assert.equal(createdResponse.status, 201);
  const { project } = await createdResponse.json();
  assert.equal(project.title, 'Test cut');

  const video = Buffer.from('fake video bytes');
  const uploadResponse = await fetch(`${baseUrl}/api/projects/${project.id}/media`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('talking head.MP4') },
    body: video,
  });
  assert.equal(uploadResponse.status, 200);
  assert.deepEqual((await uploadResponse.json()).upload, { name: 'talking head.MP4', bytes: video.length });

  const result = await fetch(`${baseUrl}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(result.project.sourceName, 'talking head.MP4');
  assert.equal(result.project.sourcePath, 'source.mp4');
  const sourcePath = path.join(dataDir, 'projects', project.id, 'source.mp4');
  assert.deepEqual(await readFile(sourcePath), video);

  const updated = await fetch(`${baseUrl}/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Revised cut', prompt: 'Keep the hook', editMode: 'full' }),
  }).then((response) => response.json());
  assert.equal(updated.project.title, 'Revised cut');
  assert.equal(updated.project.prompt, 'Keep the hook');
  assert.equal(updated.project.editMode, 'full');
});

test('rejects invalid titles and file traversal requests', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'seecut-web-'));
  tempDirectories.push(dataDir);
  const { baseUrl } = await startServer({ dataDir, repoRoot: dataDir });
  const invalid = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: ' ' }),
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Safe project' }),
  }).then((response) => response.json());
  const traversal = await fetch(`${baseUrl}/api/projects/${created.project.id}/file?path=..%2F..%2Foutside.mp4`);
  assert.equal(traversal.status, 400);
});

test('does not start a project when local AI server credentials are missing', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'seecut-web-'));
  tempDirectories.push(dataDir);
  const { baseUrl } = await startServer({ dataDir, repoRoot: dataDir });
  const { project } = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Unavailable engine' }),
  }).then((response) => response.json());
  await fetch(`${baseUrl}/api/projects/${project.id}/media`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'input.mp4' },
    body: Buffer.from('source'),
  });

  const start = await fetch(`${baseUrl}/api/projects/${project.id}/run`, { method: 'POST' });
  assert.equal(start.status, 503);
  assert.match((await start.json()).error, /OPENAI_API_KEY/);
  const saved = await fetch(`${baseUrl}/api/projects/${project.id}`).then((response) => response.json());
  assert.equal(saved.project.status, 'draft');
});

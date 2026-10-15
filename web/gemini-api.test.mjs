import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { runGeminiAgent, uploadGeminiFile } from './gemini-api.mjs';

const directories = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('uploads a video through the Gemini resumable Files API without putting the key in the URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seecut-gemini-'));
  directories.push(directory);
  const videoPath = path.join(directory, 'sample.mp4');
  await writeFile(videoPath, Buffer.from('video-bytes'));
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return new Response('', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/session' } });
    }
    return Response.json({
      file: {
        name: 'files/test-file',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/test-file',
        state: 'ACTIVE',
        mimeType: 'video/mp4',
      },
    });
  };

  const file = await uploadGeminiFile({
    apiKey: 'private-test-key',
    filePath: videoPath,
    displayName: 'sample.mp4',
    mimeType: 'video/mp4',
    onLog() {},
  });

  assert.equal(file.name, 'files/test-file');
  assert.equal(JSON.parse(requests[0].options.body).file.displayName, 'sample.mp4');
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'private-test-key');
  assert.equal(requests[0].url.includes('private-test-key'), false);
  assert.equal(requests[1].options.headers['x-goog-upload-command'], 'upload, finalize');
  assert.equal(requests[1].options.headers['content-length'], '11');
});

test('deletes a partially uploaded Gemini file if video processing fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seecut-gemini-'));
  directories.push(directory);
  const videoPath = path.join(directory, 'sample.mp4');
  await writeFile(videoPath, Buffer.from('video-bytes'));
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return new Response('', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/session' } });
    }
    if (requests.length === 2) {
      return Response.json({
        file: { name: 'files/failed-file', uri: 'https://example.test/file', state: 'PROCESSING' },
      });
    }
    if (requests.length === 3) {
      return Response.json({ name: 'files/failed-file', state: 'FAILED' });
    }
    return new Response('', { status: 200 });
  };

  await assert.rejects(uploadGeminiFile({
    apiKey: 'private-test-key',
    filePath: videoPath,
    displayName: 'sample.mp4',
    mimeType: 'video/mp4',
    onLog() {},
  }), /Gemini không xử lý được video/);
  assert.equal(requests.at(-1).options.method, 'DELETE');
  assert.match(requests.at(-1).url, /files\/failed-file$/);
});

test('executes Gemini function calls and returns tool results in the next turn', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return Response.json({
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'write_workspace_file', args: { path: 'build/SHOTBOOK.md', content: 'Shot 1' } } }],
          },
        }],
      });
    }
    return Response.json({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Shotbook saved.' }] },
      }],
    });
  };

  const result = await runGeminiAgent({
    apiKey: 'private-test-key',
    model: 'gemini-test-model',
    file: { uri: 'https://example.test/video', mimeType: 'video/mp4' },
    prompt: 'Edit this video.',
    tools: [{ name: 'write_workspace_file', parameters: { type: 'OBJECT', properties: {} } }],
    executeTool: async (name, args) => ({ tool: name, written: args.path }),
    onLog() {},
  });

  assert.equal(result, 'Shotbook saved.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].generationConfig.maxOutputTokens, 8192);
  assert.equal(requests[0].tools[0].functionDeclarations[0].name, 'write_workspace_file');
  assert.ok(requests[0].contents[0].parts[1].fileData.fileUri);
  assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.response.written, 'build/SHOTBOOK.md');
});

test('retries Gemini rate limits when the API provides a retry delay', async () => {
  let requests = 0;
  const logs = [];
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return Response.json({
        error: {
          message: 'Rate limited.',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.001s' }],
        },
      }, { status: 429 });
    }
    return Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }],
    });
  };

  const result = await runGeminiAgent({
    apiKey: 'private-test-key',
    model: 'gemini-test-model',
    file: { uri: 'https://example.test/video', mimeType: 'video/mp4' },
    prompt: 'Edit this video.',
    tools: [],
    executeTool: async () => ({}),
    onLog: (line) => logs.push(line),
  });

  assert.equal(result, 'Done.');
  assert.equal(requests, 2);
  assert.ok(logs.some((line) => line.includes('thử lại sau')));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOpenAIStatus, runOpenAIAgent } from './openai-api.mjs';

test('validates the configured model and authenticates without exposing the key', async () => {
  const status = await getOpenAIStatus({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'qwen/qwen3.6-35b-a3b',
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer private-local-token');
      if (url.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }] });
      }
      assert.equal(url, 'http://ai-server.test/api/v0/models');
      return Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b', state: 'loaded', loaded_context_length: 65536 }] });
    },
  });

  assert.equal(status.available, true);
  assert.equal(status.model, 'qwen/qwen3.6-35b-a3b');
  assert.equal(JSON.stringify(status).includes('private-local-token'), false);
});

test('rejects a configured model not provided by the server', async () => {
  const status = await getOpenAIStatus({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'missing-model',
    fetchImpl: async () => Response.json({ data: [{ id: 'available-model' }] }),
  });
  assert.equal(status.available, false);
  assert.match(status.reason, /missing-model/);
});

test('does not report a model as available while the local server has not loaded it', async () => {
  const status = await getOpenAIStatus({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'qwen/qwen3.6-35b-a3b',
    fetchImpl: async (url) => url.endsWith('/v1/models')
      ? Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }] })
      : Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b', state: 'not-loaded' }] }),
  });
  assert.equal(status.available, false);
  assert.match(status.reason, /chưa được nạp/);
});

test('blocks an LM Studio model loaded with an insufficient context window', async () => {
  const status = await getOpenAIStatus({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'qwen/qwen3.6-35b-a3b',
    fetchImpl: async (url) => url.endsWith('/v1/models')
      ? Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }] })
      : Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b', state: 'loaded', loaded_context_length: 4096 }] }),
  });
  assert.equal(status.available, false);
  assert.match(status.reason, /context_length=65536/);
});

test('recognizes a sufficient LM Studio v1 instance when v0 reports the model alias unloaded', async () => {
  const status = await getOpenAIStatus({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'qwen/qwen3.6-35b-a3b',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/v1/models')) {
        return Response.json({
          models: [{
            key: 'qwen/qwen3.6-35b-a3b',
            loaded_instances: [{
              id: 'qwen/qwen3.6-35b-a3b:2',
              config: { context_length: 65536 },
            }],
          }],
        });
      }
      if (url.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }] });
      }
      if (url.endsWith('/api/v0/models')) {
        return Response.json({ data: [{ id: 'qwen/qwen3.6-35b-a3b', state: 'not-loaded' }] });
      }
      throw new Error(`Unexpected model status request: ${url}`);
    },
  });
  assert.equal(status.available, true);
  assert.equal(status.reason, null);
});

test('runs OpenAI-compatible tool calls and sends sampled frames as image URLs', async () => {
  const requests = [];
  const logs = [];
  const result = await runOpenAIAgent({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'local-vision-model',
    frames: [{ timestamp: 1, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==' }],
    prompt: 'Edit this footage.',
    tools: [{
      name: 'write_workspace_file',
      description: 'Write a file',
      parameters: {
        type: 'OBJECT',
        properties: { path: { type: 'STRING' } },
        required: ['path'],
      },
    }],
    executeTool: async (name, args) => ({ name, path: args.path }),
    onLog: (line) => logs.push(line),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://ai-server.test/v1/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer private-local-token');
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'write_workspace_file', arguments: '{"path":"build/SHOTBOOK.md"}' },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Shotbook written.' } }] });
    },
  });

  assert.equal(result, 'Shotbook written.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.parameters.type, 'object');
  assert.equal(requests[0].tools[0].function.parameters.properties.path.type, 'string');
  const imagePart = requests[0].messages[1].content.find((part) => part.type === 'image_url');
  assert.equal(imagePart.image_url.url, 'data:image/jpeg;base64,ZmFrZQ==');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).path, 'build/SHOTBOOK.md');
  assert.ok(logs.some((line) => line.includes('Thực thi bước được phép')));
});

test('stops after an unbounded server rate-limit response instead of retrying forever', async () => {
  let requests = 0;
  await assert.rejects(runOpenAIAgent({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'local-model',
    frames: [],
    prompt: 'Test.',
    tools: [],
    executeTool: async () => ({}),
    onLog() {},
    fetchImpl: async () => {
      requests += 1;
      return new Response('rate limited', { status: 429 });
    },
  }), /HTTP 429/);
  assert.equal(requests, 1);
});

test('explains how to fix a model context-size error', async () => {
  await assert.rejects(runOpenAIAgent({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'local-model',
    frames: [],
    prompt: 'Test.',
    tools: [],
    executeTool: async () => ({}),
    onLog() {},
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        message: 'request (17189 tokens) exceeds the available context size (4096 tokens)',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 17189,
        n_ctx: 4096,
      },
    }), { status: 400 }),
  }), /ít nhất 17408/);
});

test('retries transient network failures and surfaces the cause if they persist', async () => {
  let requests = 0;
  const logs = [];
  const result = await runOpenAIAgent({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'local-model',
    frames: [],
    prompt: 'Test.',
    tools: [],
    executeTool: async () => ({}),
    onLog: (line) => logs.push(line),
    fetchImpl: async () => {
      requests += 1;
      if (requests < 3) {
        const error = new TypeError('fetch failed');
        error.cause = new Error('connect ECONNRESET');
        throw error;
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Connected.' } }] });
    },
  });
  assert.equal(result, 'Connected.');
  assert.equal(requests, 3);
  assert.equal(logs.filter((line) => line.includes('ECONNRESET')).length, 2);

  requests = 0;
  await assert.rejects(runOpenAIAgent({
    apiKey: 'private-local-token',
    baseUrl: 'http://ai-server.test/v1',
    model: 'local-model',
    frames: [],
    prompt: 'Test.',
    tools: [],
    executeTool: async () => ({}),
    onLog() {},
    fetchImpl: async () => {
      requests += 1;
      const error = new TypeError('fetch failed');
      error.cause = new Error('connect ECONNREFUSED');
      throw error;
    },
  }), /sau 4 lần thử: connect ECONNREFUSED/);
  assert.equal(requests, 4);
});

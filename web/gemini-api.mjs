import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

const API_ROOT = 'https://generativelanguage.googleapis.com';
const MAX_AGENT_TURNS = 48;

export function getGeminiStatus(apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || 'gemini-2.5-flash') {
  const available = Boolean(apiKey?.trim());
  return {
    available,
    model,
    reason: available ? null : 'Chưa cấu hình Gemini API key. Hãy đặt GEMINI_API_KEY trong môi trường của web server rồi khởi động lại.',
  };
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label}: Gemini trả về phản hồi không phải JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const message = body.error?.message || `HTTP ${response.status}`;
    const error = new Error(`${label}: ${message}`);
    error.status = response.status;
    error.responseBody = body;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  return body;
}

function retryDelayMs(error) {
  const retryInfo = error.responseBody?.error?.details?.find((detail) =>
    detail['@type']?.endsWith('RetryInfo') && typeof detail.retryDelay === 'string');
  const retryInfoMatch = retryInfo?.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
  if (retryInfoMatch) return Math.ceil(Number(retryInfoMatch[1]) * 1000);

  if (error.retryAfter) {
    const seconds = Number(error.retryAfter);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
    const dateDelay = Date.parse(error.retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return dateDelay;
  }

  const messageMatch = error.message.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  return messageMatch ? Math.ceil(Number(messageMatch[1]) * 1000) : null;
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Tác vụ đã dừng.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('Tác vụ đã dừng.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function uploadGeminiFile({ apiKey, filePath, displayName, mimeType, signal, onLog }) {
  const { size } = await stat(filePath);
  const start = await fetch(`${API_ROOT}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(size),
      'x-goog-upload-header-content-type': mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { displayName } }),
    signal,
  });
  if (!start.ok) await responseJson(start, 'Không thể bắt đầu tải video lên Gemini');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini không trả về URL tải file resumable.');

  onLog(`Đang tải video lên Gemini Files API (${(size / 1024 / 1024).toFixed(1)} MB)…`);
  const stream = Readable.toWeb(createReadStream(filePath));
  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'content-length': String(size),
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
    },
    body: stream,
    duplex: 'half',
    signal,
  });
  const body = await responseJson(uploaded, 'Tải video lên Gemini thất bại');
  const file = body.file || body;
  if (!file.name || !file.uri) throw new Error('Gemini không trả về file URI sau khi tải video.');

  try {
    const deadline = Date.now() + 15 * 60_000;
    let current = file;
    while (current.state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(signal.reason || new Error('Tác vụ đã dừng.'));
        };
        const timer = setTimeout(finish, 4_000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      const status = await fetch(`${API_ROOT}/v1beta/${file.name}`, {
        headers: { 'x-goog-api-key': apiKey },
        signal,
      });
      current = await responseJson(status, 'Không thể kiểm tra trạng thái video Gemini');
    }
    if (current.state !== 'ACTIVE') {
      throw new Error(current.state === 'FAILED'
        ? 'Gemini không xử lý được video này.'
        : 'Đã hết thời gian chờ Gemini xử lý video.');
    }
    return { name: current.name, uri: current.uri, mimeType: current.mimeType || mimeType };
  } catch (error) {
    try {
      await deleteGeminiFile({ apiKey, name: file.name });
    } catch (cleanupError) {
      onLog(`Không xoá được video tải lên dở trên Gemini: ${cleanupError.message}`);
    }
    throw error;
  }
}

export async function deleteGeminiFile({ apiKey, name }) {
  if (!name) return;
  const response = await fetch(`${API_ROOT}/v1beta/${name}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 404) {
    await responseJson(response, 'Không thể xoá file tạm trên Gemini');
  }
}

async function generateContent({ apiKey, model, contents, tools, signal, onLog }) {
  const body = {
    contents,
    generationConfig: { temperature: 0.25, maxOutputTokens: 8192 },
  };
  if (tools) {
    body.tools = [{ functionDeclarations: tools }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${API_ROOT}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000),
      });
      return await responseJson(response, 'Gemini API gặp lỗi');
    } catch (error) {
      const delay = error.status === 429 ? retryDelayMs(error) : null;
      if (attempt === 3 || delay === null || delay > 120_000) throw error;
      onLog?.(`Gemini giới hạn tốc độ; thử lại sau ${(delay / 1000).toFixed(1)} giây.`);
      await waitForRetry(delay, signal);
    }
  }
  throw new Error('Gemini vượt quá số lần thử lại.');
}

async function generateVideoReview({ apiKey, model, reference, candidate, task, signal, onLog }) {
  const prompt = [
    'Bạn là kiểm định viên video SeeCut độc lập. Xem trực tiếp cả hai video; không đoán từ tên file.',
    task,
    'Trả lời ngắn gọn nhưng nêu mốc thời gian cụ thể cho các vấn đề quan sát được. Nếu không thấy video hoặc không thể so sánh, phải nói rõ; không bịa.',
  ].join('\n\n');
  const result = await generateContent({
    apiKey,
    model,
    signal,
    onLog,
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { text: 'Video A:' },
        { fileData: { mimeType: reference.mimeType, fileUri: reference.uri } },
        { text: 'Video B:' },
        { fileData: { mimeType: candidate.mimeType, fileUri: candidate.uri } },
      ],
    }],
  });
  const parts = result.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part.text || '').filter(Boolean).join('\n').trim();
  if (!text) throw new Error('Gemini không trả về kết quả kiểm duyệt video.');
  return text;
}

export async function reviewGeminiVideo({
  apiKey, model, source, candidatePath, candidateName, candidateMimeType, signal, onLog,
}) {
  let candidate;
  try {
    candidate = await uploadGeminiFile({
      apiKey, filePath: candidatePath, displayName: candidateName,
      mimeType: candidateMimeType, signal, onLog,
    });
    return await generateVideoReview({
      apiKey, model, reference: source, candidate, signal,
      onLog,
      task: 'Đánh giá video B theo SeeCut: tự nhiên/đúng nhịp, hình ảnh và bố cục, bằng chứng, che mặt, chữ đọc được, chuyển cảnh, đồng bộ với lời nói và lỗi hiển thị. Liệt kê hard defects trước; đưa thời điểm.',
    });
  } finally {
    if (candidate) {
      try {
        await deleteGeminiFile({ apiKey, name: candidate.name });
      } catch (error) {
        onLog(`Không xoá được video review tạm trên Gemini: ${error.message}`);
      }
    }
  }
}

export async function compareGeminiVideos({
  apiKey, model, pathA, pathB, mimeA, mimeB, signal, onLog,
}) {
  let fileA;
  let fileB;
  try {
    fileA = await uploadGeminiFile({
      apiKey, filePath: pathA, displayName: 'seecut-version-a', mimeType: mimeA, signal, onLog,
    });
    fileB = await uploadGeminiFile({
      apiKey, filePath: pathB, displayName: 'seecut-version-b', mimeType: mimeB, signal, onLog,
    });
    const first = await generateVideoReview({
      apiKey, model, reference: fileA, candidate: fileB, signal,
      onLog,
      task: 'So sánh phiên bản A (trước) với B (sau). Chọn winner=A, winner=B hoặc tie. Ưu tiên bản hoàn chỉnh, chính xác, dễ xem; nêu bằng chứng thời gian.',
    });
    const swapped = await generateVideoReview({
      apiKey, model, reference: fileB, candidate: fileA, signal,
      onLog,
      task: 'So sánh phiên bản A (trước) với B (sau). Chọn winner=A, winner=B hoặc tie. Ưu tiên bản hoàn chỉnh, chính xác, dễ xem; nêu bằng chứng thời gian.',
    });
    return { orderAB: first, orderBA: swapped };
  } finally {
    for (const file of [fileA, fileB]) {
      if (!file) continue;
      try {
        await deleteGeminiFile({ apiKey, name: file.name });
      } catch (error) {
        onLog(`Không xoá được file so sánh tạm trên Gemini: ${error.message}`);
      }
    }
  }
}

export async function runGeminiAgent({
  apiKey,
  model = 'gemini-2.5-flash',
  file,
  prompt,
  tools,
  executeTool,
  signal,
  onLog,
}) {
  let contents = [{
    role: 'user',
    parts: [
      { text: prompt },
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    ],
  }];

  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn += 1) {
    if (signal?.aborted) throw signal.reason || new Error('Tác vụ đã dừng.');
    onLog(`Gemini: lượt làm việc ${turn}/${MAX_AGENT_TURNS}.`);
    const result = await generateContent({ apiKey, model, contents, tools, signal, onLog });
    const candidate = result.candidates?.[0];
    if (!candidate?.content?.parts) {
      const blockReason = result.promptFeedback?.blockReason;
      throw new Error(blockReason
        ? `Gemini từ chối xử lý yêu cầu (lý do: ${blockReason}).`
        : 'Gemini không trả về nội dung chỉnh sửa.');
    }

    const modelParts = candidate.content.parts;
    const calls = modelParts.filter((part) => part.functionCall);
    contents = [...contents, { role: 'model', parts: modelParts }];
    if (!calls.length) {
      const answer = modelParts.map((part) => part.text || '').filter(Boolean).join('\n').trim();
      if (answer) onLog(answer);
      return answer;
    }

    const responses = [];
    for (const part of calls) {
      const call = part.functionCall;
      onLog(`Thực thi bước được phép: ${call.name}.`);
      let response;
      try {
        response = await executeTool(call.name, call.args || {});
      } catch (error) {
        response = { error: error.message || 'Bước này thất bại.' };
        onLog(`Bước ${call.name} thất bại: ${response.error}`);
      }
      responses.push({ functionResponse: { name: call.name, response } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  throw new Error(`Gemini vượt quá giới hạn ${MAX_AGENT_TURNS} lượt thao tác.`);
}

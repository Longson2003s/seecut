import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EDITABLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.md', '.txt']);
const REFERENCE_ROOTS = ['skill/seecut', 'digital-human', 'jianying'];
const WORKFLOW_REFERENCES = [
  'skill/seecut/SKILL.md',
  'skill/seecut/references/00-总纲.md',
  'skill/seecut/references/08-避坑SOP.md',
  'skill/seecut/references/01-方法论.md',
  'skill/seecut/references/02-设计令牌Design-Reference.md',
  'skill/seecut/references/03-编排层决策表.md',
  'skill/seecut/references/04-SHOTBOOK施工规格.md',
  'skill/seecut/references/05-视觉质量地板.md',
  'skill/seecut/references/06-质检闭环spec.md',
  'skill/seecut/references/07-几何规则自检spec.md',
  'skill/seecut/references/11-无据段画法参考.md',
];
const TOOL_DECLARATIONS = [
  {
    name: 'read_workflow_references',
    description: 'Đọc một lần các hướng dẫn và tài liệu workflow SeeCut đã được cho phép.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'read_reference',
    description: 'Đọc một tài liệu hoặc script có sẵn trong repo SeeCut. Đường dẫn tương đối với repo root, ví dụ skill/seecut/SKILL.md.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
  },
  {
    name: 'list_workspace_files',
    description: 'Liệt kê file dự án mà AI đã tạo, không đọc video nguồn.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'read_workspace_file',
    description: 'Đọc một file văn bản trong workspace dự án.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
  },
  {
    name: 'write_workspace_file',
    description: 'Tạo hoặc thay thế một file văn bản trong workspace dự án. Không thể ghi đè video nguồn, file quản lý dự án hoặc file ngoài workspace.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Đường dẫn tương đối bên trong workspace.' },
        content: { type: 'STRING', description: 'Toàn bộ nội dung file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_pipeline_step',
    description: 'Chạy một bước SeeCut có sẵn; không nhận lệnh shell tùy ý.',
    parameters: {
      type: 'OBJECT',
      properties: {
        step: {
          type: 'STRING',
          enum: ['check_environment', 'catalog', 'setup_browser', 'render_probe', 'geometry_check', 'render_full', 'package_mp4'],
        },
        build_directory: { type: 'STRING', description: 'Thư mục build tương đối trong workspace, thường là build.' },
        version: { type: 'INTEGER', description: 'Số phiên bản 1–3 dùng cho bước package_mp4.' },
      },
      required: ['step'],
    },
  },
  {
    name: 'review_output_video',
    description: 'Cho Gemini xem trực tiếp video dựng và trả về hard defects cùng các mốc thời gian.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
  },
  {
    name: 'compare_output_videos',
    description: 'Cho Gemini so sánh hai phiên bản video; đánh giá hai lần và đổi thứ tự A/B.',
    parameters: {
      type: 'OBJECT',
      properties: { path_a: { type: 'STRING' }, path_b: { type: 'STRING' } },
      required: ['path_a', 'path_b'],
    },
  },
];

function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) {
    throw new Error('Cần đường dẫn tương đối bên trong workspace.');
  }
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Đường dẫn vượt ra ngoài workspace.');
  return absolute;
}

async function ensureNoSymlinkPath(root, target, allowMissingFinal = false) {
  const rel = path.relative(root, target);
  const parts = rel.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error('Không cho phép truy cập qua symbolic link.');
      if (index < parts.length - 1 && !entry.isDirectory()) throw new Error('Đường dẫn cha không phải thư mục.');
    } catch (error) {
      if (error.code === 'ENOENT' && (allowMissingFinal || index < parts.length - 1)) continue;
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function filesUnder(root, directory = root, results = [], depth = 0) {
  if (depth > 5 || results.length >= 250) return results;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await filesUnder(root, absolute, results, depth + 1);
    } else if (entry.isFile() && EDITABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return results;
}

function runProcess(command, args, { cwd, signal, onLog, timeoutMs = 30 * 60_000, shell = false }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Tác vụ đã dừng.'));
    const child = spawn(command, args, { cwd, windowsHide: true, shell });
    const chunks = [];
    let totalBytes = 0;
    let closed = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (stream, name) => stream.on('data', (buffer) => {
      const text = buffer.toString();
      totalBytes += Buffer.byteLength(text);
      chunks.push(text);
      onLog(`[${name}] ${text}`);
    });
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');
    child.on('error', (error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error(`Không thể chạy ${command}: ${error.message}`));
    });
    child.on('close', (code, closeSignal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const output = chunks.join('').slice(-20_000);
      if (signal?.aborted) return reject(signal.reason || new Error('Tác vụ đã dừng.'));
      if (closeSignal) return reject(new Error(`${command} bị dừng (${closeSignal}).`));
      if (code !== 0) return reject(new Error(`${command} kết thúc với mã ${code}.\n${output}`));
      resolve({ exitCode: code, output: totalBytes > 20_000 ? `${output}\n[log đã rút gọn]` : output });
    });
  });
}

function findExecutable(name) {
  const extensions = process.platform === 'win32'
    ? (path.extname(name) ? [''] : ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')])
    : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function packageManagerCli(name) {
  if (process.platform === 'win32') {
    const scriptName = name === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
    const scriptPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', scriptName);
    if (existsSync(scriptPath)) return { command: process.execPath, args: [scriptPath] };
    throw new Error(`Không tìm thấy ${scriptName} cạnh Node.js; cài lại Node.js kèm npm.`);
  }

  const executable = findExecutable(name);
  if (!executable) throw new Error(`Không tìm thấy ${name}.`);
  return { command: executable, args: [] };
}

function getMimeType(extension) {
  const types = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  };
  return types[extension] || 'application/octet-stream';
}

export function createPipelineTools({ project, repoRoot, signal, onLog }) {
  const workspace = path.resolve(project.directory);
  const referenceRoots = REFERENCE_ROOTS.map((item) => path.resolve(repoRoot, item));
  async function buildPath(relative) {
    const build = safePath(workspace, relative || 'build');
    await ensureNoSymlinkPath(workspace, build, true);
    await mkdir(build, { recursive: true });
    const realWorkspace = await realpath(workspace);
    const realBuild = await realpath(build);
    if (!realBuild.startsWith(`${realWorkspace}${path.sep}`)) throw new Error('Build directory không hợp lệ.');
    return realBuild;
  }

  return {
    declarations: TOOL_DECLARATIONS,
    async execute(name, args) {
      if (name === 'read_workflow_references') {
        const references = await Promise.all(WORKFLOW_REFERENCES.map(async (relative) => {
          const candidate = path.resolve(repoRoot, relative);
          if (!referenceRoots.some((root) => candidate.startsWith(`${root}${path.sep}`))) {
            throw new Error('Danh sách tài liệu workflow chứa đường dẫn không được phép.');
          }
          return { path: relative, content: (await readFile(candidate, 'utf8')).slice(0, 50_000) };
        }));
        return { references };
      }
      if (name === 'read_reference') {
        const candidate = path.resolve(repoRoot, String(args.path || ''));
        if (!referenceRoots.some((root) => candidate.startsWith(`${root}${path.sep}`))) {
          throw new Error('Chỉ được đọc tài liệu trong skill/seecut, digital-human hoặc jianying.');
        }
        const contents = await readFile(candidate, 'utf8');
        return { path: path.relative(repoRoot, candidate), content: contents.slice(0, 50_000) };
      }
      if (name === 'list_workspace_files') {
        const files = await filesUnder(workspace);
        return { files };
      }
      if (name === 'read_workspace_file') {
        const candidate = safePath(workspace, args.path);
        if (!EDITABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) throw new Error('Chỉ đọc file văn bản.');
        await ensureNoSymlinkPath(workspace, candidate);
        const info = await lstat(candidate);
        if (!info.isFile() || info.size > 256 * 1024) throw new Error('File không tồn tại hoặc lớn hơn 256 KB.');
        return { path: args.path, content: await readFile(candidate, 'utf8') };
      }
      if (name === 'write_workspace_file') {
        const candidate = safePath(workspace, args.path);
        const relative = path.relative(workspace, candidate).split(path.sep).join('/');
        if (!EDITABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) throw new Error('Chỉ tạo file HTML, CSS, JS, JSON, Markdown hoặc text.');
        if (relative === 'project.json' || relative === 'EDIT_REQUEST.md' || relative === 'run.log'
          || (project.sourcePath && relative === project.sourcePath)) {
          throw new Error('File này do server quản lý và không thể ghi đè.');
        }
        if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 1024 * 1024) {
          throw new Error('Nội dung file vượt giới hạn 1 MB.');
        }
        await ensureNoSymlinkPath(workspace, candidate, true);
        await mkdir(path.dirname(candidate), { recursive: true });
        await ensureNoSymlinkPath(workspace, candidate, true);
        const temp = path.join(path.dirname(candidate), `.${path.basename(candidate)}.${randomUUID()}.tmp`);
        await writeFile(temp, args.content, { encoding: 'utf8', flag: 'wx' });
        await rename(temp, candidate);
        return { written: relative, bytes: Buffer.byteLength(args.content, 'utf8') };
      }
      if (name !== 'run_pipeline_step') throw new Error(`Tool không được phép: ${name}`);

      const step = String(args.step || '');
      const build = await buildPath(args.build_directory || 'build');
      if (step === 'check_environment') {
        const ffmpeg = findExecutable('ffmpeg');
        const python = findExecutable('python') || findExecutable('python3');
        const npx = findExecutable('npx');
        return {
          node: process.version,
          supportedNode: Number(process.versions.node.split('.')[0]) >= 22,
          platform: os.platform(),
          ffmpeg: Boolean(ffmpeg),
          python: Boolean(python),
          npx: Boolean(npx),
          note: os.platform() === 'win32'
            ? 'Windows pipeline chưa được repo kiểm thử; một số lệnh tài liệu dùng zsh.'
            : null,
        };
      }
      if (step === 'catalog') {
        const npx = packageManagerCli('npx');
        return runProcess(npx.command, [...npx.args, '-y', 'hyperframes@latest', 'catalog'], {
          cwd: workspace, signal, onLog,
        });
      }
      if (step === 'setup_browser') {
        const npm = packageManagerCli('npm');
        return runProcess(npm.command, [...npm.args, 'install', '--no-save', '--ignore-scripts', 'playwright-core'], {
          cwd: build, signal, onLog,
        });
      }
      if (step === 'render_probe' || step === 'render_full' || step === 'geometry_check') {
        const script = step === 'geometry_check'
          ? path.join(repoRoot, 'skill', 'seecut', 'scripts', 'geom-check.mjs')
          : path.join(repoRoot, 'skill', 'seecut', 'scripts', 'render.mjs');
        const mode = step === 'render_full' ? 'full' : 'probe';
        const commandArgs = step === 'geometry_check' ? [script, build] : [script, build, mode];
        return runProcess(process.execPath, commandArgs, { cwd: workspace, signal, onLog });
      }
      if (step === 'package_mp4') {
        const projectConfig = JSON.parse(await readFile(path.join(build, 'project.json'), 'utf8'));
        const fps = Number(projectConfig.fps);
        const duration = Number(projectConfig.duration);
        const source = path.resolve(build, projectConfig.source || '');
        const realWorkspace = await realpath(workspace);
        const realSource = await realpath(source);
        if (!realSource.startsWith(`${realWorkspace}${path.sep}`)) throw new Error('Nguồn render phải nằm trong workspace.');
        if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) {
          throw new Error('project.json thiếu fps/duration hợp lệ.');
        }
        const ffmpeg = findExecutable(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        if (!ffmpeg) throw new Error('Không tìm thấy ffmpeg để đóng gói video.');
        const version = Number(args.version);
        if (!Number.isInteger(version) || version < 1 || version > 3) {
          throw new Error('package_mp4 cần version là số nguyên từ 1 đến 3.');
        }
        const output = path.join(workspace, `final_v${version}.mp4`);
        return runProcess(ffmpeg, [
          '-y',
          '-framerate', String(fps),
          '-start_number', '0',
          '-i', path.join(build, 'frames', 'f%04d.png'),
          '-i', realSource,
          '-map', '0:v:0',
          '-map', '1:a:0?',
          '-t', String(duration),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-r', String(fps),
          '-c:a', 'aac',
          '-shortest',
          '-movflags', '+faststart',
          output,
        ], { cwd: workspace, signal, onLog });
      }
      throw new Error(`Pipeline step không được hỗ trợ: ${step}`);
    },
    async review(name, args, videoContext) {
      if (name !== 'review_output_video' && name !== 'compare_output_videos') {
        throw new Error(`Review tool không được hỗ trợ: ${name}`);
      }
      const first = safePath(workspace, args.path_a || args.path);
      const firstInfo = await lstat(first);
      if (!firstInfo.isFile() || !['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(path.extname(first).toLowerCase())) {
        throw new Error('File review phải là video đã render trong workspace.');
      }
      await ensureNoSymlinkPath(workspace, first);
      const firstReal = await realpath(first);
      if (!firstReal.startsWith(`${workspace}${path.sep}`)) throw new Error('Video review phải nằm trong workspace.');
      const firstMime = getMimeType(path.extname(firstReal).toLowerCase());

      if (name === 'review_output_video') {
        return videoContext.review({
          candidatePath: firstReal,
          candidateName: path.basename(firstReal),
          candidateMimeType: firstMime,
        });
      }

      const second = safePath(workspace, args.path_b);
      const secondInfo = await lstat(second);
      if (!secondInfo.isFile() || !['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(path.extname(second).toLowerCase())) {
        throw new Error('Cả hai file so sánh phải là video đã render.');
      }
      await ensureNoSymlinkPath(workspace, second);
      const secondReal = await realpath(second);
      if (!secondReal.startsWith(`${workspace}${path.sep}`)) throw new Error('Video so sánh phải nằm trong workspace.');
      return videoContext.compare({
        pathA: firstReal,
        pathB: secondReal,
        mimeA: firstMime,
        mimeB: getMimeType(path.extname(secondReal).toLowerCase()),
      });
    },
  };
}

export function detectVideoMime(filePath) {
  return getMimeType(path.extname(filePath).toLowerCase());
}

export async function prepareVideoForMode({ project, signal, onLog }) {
  const source = path.join(project.directory, project.sourcePath);
  const info = await stat(source);
  if (project.editMode !== 'sample') return { filePath: source, bytes: info.size };

  const ffmpeg = findExecutable(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!ffmpeg) throw new Error('Không tìm thấy ffmpeg để cắt sample 30 giây trước khi gửi video cho Gemini.');
  const extension = path.extname(source).toLowerCase();
  const sample = path.join(project.directory, `source_sample${extension}`);
  onLog('Đang tạo sample tối đa 30 giây; chỉ sample này được gửi cho Gemini.');
  await runProcess(ffmpeg, [
    '-y', '-i', source, '-t', '30',
    '-map', '0:v:0', '-map', '0:a?',
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', sample,
  ], { cwd: project.directory, signal, onLog });
  const sampleInfo = await stat(sample);
  if (sampleInfo.size === 0) throw new Error('ffmpeg không tạo được video sample.');
  return { filePath: sample, bytes: sampleInfo.size };
}

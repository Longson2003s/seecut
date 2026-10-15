import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createPipelineTools } from './pipeline-tools.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('reads only SeeCut references and scopes generated files to the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seecut-tools-'));
  directories.push(root);
  const project = { directory: path.join(root, 'project'), sourcePath: 'source.mp4' };
  const repoRoot = path.join(root, 'repo');
  const tools = createPipelineTools({ project, repoRoot, onLog() {} });
  await mkdir(project.directory, { recursive: true });
  await writeFile(path.join(project.directory, 'source.mp4'), 'source');
  await mkdir(path.join(repoRoot, 'skill', 'seecut', 'references'), { recursive: true });
  const workflowReferences = [
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
  for (const reference of workflowReferences) {
    const absolute = path.join(repoRoot, ...reference.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, reference);
  }

  const bundle = await tools.execute('read_workflow_references', {});
  assert.equal(bundle.references.length, workflowReferences.length);
  assert.equal(bundle.references[0].content, workflowReferences[0]);
  assert.equal(bundle.references[1].path, workflowReferences[1]);
  assert.equal(
    (await tools.execute('read_reference', { path: 'skill/seecut/references/00-总纲.md' })).content,
    workflowReferences[1],
  );
  await assert.rejects(
    tools.execute('read_reference', { path: 'references/00-guide.md' }),
    /Chỉ được đọc tài liệu/,
  );

  const written = await tools.execute('write_workspace_file', {
    path: 'build/SHOTBOOK.md',
    content: 'Cut list',
  });
  assert.equal(written.written, 'build/SHOTBOOK.md');
  assert.equal(await readFile(path.join(project.directory, 'build', 'SHOTBOOK.md'), 'utf8'), 'Cut list');

  await assert.rejects(
    tools.execute('write_workspace_file', { path: '../outside.md', content: 'no' }),
    /vượt ra ngoài workspace/,
  );
  await assert.rejects(
    tools.execute('write_workspace_file', { path: 'project.json', content: '{}' }),
    /do server quản lý/,
  );
  await assert.rejects(
    tools.execute('run_pipeline_step', { step: 'run_shell', command: 'whoami' }),
    /không được hỗ trợ/,
  );
});

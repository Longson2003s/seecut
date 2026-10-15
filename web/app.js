const $ = (selector) => document.querySelector(selector);
const state = {
  status: null,
  project: null,
  selectedFile: null,
  sourceUrl: null,
  events: null,
  toastTimer: null,
};

const els = {
  title: $('#project-title'),
  fileInput: $('#video-input'),
  dropzone: $('#dropzone'),
  uploadTitle: $('#upload-title'),
  uploadSubtitle: $('#upload-subtitle'),
  previewWrap: $('#video-preview'),
  preview: $('#source-preview'),
  videoName: $('#video-name'),
  videoDetails: $('#video-details'),
  prompt: $('#user-prompt'),
  promptCount: $('#prompt-count'),
  run: $('#run-button'),
  cancel: $('#cancel-button'),
  warning: $('#environment-warning'),
  statusPill: $('#status-pill'),
  resultTitle: $('#result-title'),
  resultDescription: $('#result-description'),
  progress: $('#progress-bar'),
  progressLabel: $('#progress-label'),
  progressPercent: $('#progress-percent'),
  outputList: $('#output-list'),
  log: $('#log-window'),
  projectList: $('#project-list'),
  engineDot: $('#engine-dot'),
  engineStatus: $('#engine-status'),
  toast: $('#toast'),
  breadcrumb: $('#breadcrumb-title'),
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 4200);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `Yêu cầu lỗi (${response.status}).`);
  return body;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function resetLog() {
  els.log.innerHTML = '<div class="log-empty"><span>✳</span><p>Nhật ký tiến trình sẽ xuất hiện ở đây khi AI bắt đầu làm việc.</p></div>';
}

function appendLog(text, stream = 'stdout') {
  if (!text) return;
  els.log.querySelector('.log-empty')?.remove();
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const item = document.createElement('div');
    item.className = `log-line${stream === 'stderr' ? ' stderr' : ''}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date().toLocaleTimeString([], { hour12: false });
    item.append(time, document.createTextNode(line));
    els.log.append(item);
  }
  while (els.log.childElementCount > 500) els.log.firstElementChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

function setProject(project) {
  state.project = project;
  els.breadcrumb.textContent = project?.title || 'Studio';
  if (project) {
    els.title.value = project.title;
    els.prompt.value = project.prompt || '';
    els.promptCount.textContent = `${els.prompt.value.length} / 10000`;
    const mode = document.querySelector(`input[name="edit-mode"][value="${project.editMode}"]`);
    if (mode) {
      mode.checked = true;
      updateModeSelection();
    }
    els.fileInput.disabled = Boolean(project.sourcePath);
    els.dropzone.classList.toggle('locked', Boolean(project.sourcePath));
    if (project.sourceName) {
      els.uploadTitle.textContent = project.sourceName;
      els.uploadSubtitle.textContent = project.sourcePath
        ? 'Video đã lưu · tạo dự án mới để thay video'
        : 'Video đã được lưu trong workspace dự án';
      if (project.sourcePath && !state.selectedFile) {
        if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
        state.sourceUrl = null;
        els.preview.pause();
        els.preview.removeAttribute('src');
        els.preview.load();
        els.previewWrap.classList.add('hidden');
      }
      if (!state.selectedFile) {
        els.dropzone.classList.remove('hidden');
        els.dropzone.querySelector('.upload-icon').innerHTML = '<span>✓</span>';
      }
    }
  }
  renderProjectStatus();
  refreshOutputs();
  renderProjectList();
}

function renderProjectStatus() {
  const project = state.project;
  const fileReady = Boolean(project?.sourcePath || state.selectedFile);
  const running = project?.status === 'running';
  const labels = {
    draft: ['NHÁP', 'Sẵn sàng bắt đầu'],
    running: ['ĐANG DỰNG', 'SeeCut đang xử lý video'],
    completed: ['HOÀN TẤT', 'Tác vụ đã kết thúc thành công'],
    failed: ['CẦN KIỂM TRA', 'Tác vụ dừng do lỗi — xem log để biết lý do'],
    cancelled: ['ĐÃ DỪNG', 'Tác vụ đã được dừng theo yêu cầu'],
    interrupted: ['BỊ GIÁN ĐOẠN', 'Web server đã khởi động lại khi tác vụ còn chạy'],
  };
  const [pill, title] = labels[project?.status] || labels.draft;
  els.statusPill.textContent = pill;
  els.statusPill.className = `status-pill ${project?.status || 'idle'}`;
  els.resultTitle.textContent = title;
  els.resultDescription.textContent = project
    ? `Dự án "${project.title}" · video và kết quả lưu cục bộ.`
    : 'Video và file đầu ra được lưu cục bộ trong workspace của dự án.';
  els.run.classList.toggle('hidden', running);
  els.cancel.classList.toggle('hidden', !running);
  els.progress.classList.toggle('indeterminate', running);
  els.progress.style.width = running ? '' : (project?.status === 'completed' ? '100%' : '0%');
  els.progressLabel.textContent = running
    ? 'AI đang làm việc — xem tiến trình bên dưới'
    : fileReady ? (project?.status === 'completed' ? 'Đã hoàn tất' : 'Sẵn sàng dựng') : 'Đang chờ video';
  els.progressPercent.textContent = running ? 'LIVE' : (project?.status === 'completed' ? '100%' : '—');
  const providerMissing = state.status && !state.status.openai.available;
  const oldNode = state.status && !state.status.nodeSupported;
  const platformNote = state.status?.platformNote;
  const warning = providerMissing ? state.status.openai.reason
    : oldNode ? 'Cần Node.js 22 trở lên để chạy SeeCut.'
      : platformNote;
  els.warning.textContent = warning || '';
  els.warning.classList.toggle('hidden', !warning);
  els.run.disabled = !fileReady || running || providerMissing || oldNode || ['completed', 'cancelled'].includes(project?.status);
  els.run.title = providerMissing ? state.status.openai.reason : '';
  els.title.disabled = running;
  els.prompt.disabled = running;
  document.querySelectorAll('.mode-card input').forEach((input) => { input.disabled = running; });
}

function updateModeSelection() {
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.classList.toggle('selected', card.querySelector('input').checked);
  });
}

function renderProjectList(projects = state.projects || []) {
  if (!projects.length) {
    els.projectList.innerHTML = '<div class="empty-projects">Chưa có dự án</div>';
    return;
  }
  els.projectList.replaceChildren();
  for (const project of projects.slice(0, 15)) {
    const button = document.createElement('button');
    button.className = `project-link${project.id === state.project?.id ? ' active' : ''}`;
    button.type = 'button';
    button.innerHTML = '<span class="project-mini-icon">◧</span>';
    const label = document.createElement('span');
    label.textContent = project.title;
    button.append(label);
    button.addEventListener('click', () => openProject(project.id));
    els.projectList.append(button);
  }
}

async function loadProjects() {
  const result = await api('/api/projects');
  state.projects = result.projects;
  renderProjectList();
}

function setFile(file) {
  if (!file) return;
  const allowed = /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
  if (!allowed) return showToast('Hãy chọn video MP4, MOV, M4V, WebM hoặc MKV.');
  if (file.size > 4 * 1024 * 1024 * 1024) return showToast('Video vượt giới hạn 4 GB.');
  state.selectedFile = file;
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = URL.createObjectURL(file);
  els.preview.src = state.sourceUrl;
  els.videoName.textContent = file.name;
  els.videoDetails.textContent = `${formatBytes(file.size)} · đang kiểm tra thời lượng`;
  els.dropzone.classList.add('hidden');
  els.previewWrap.classList.remove('hidden');
  els.preview.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(els.preview.duration) ? `${Math.round(els.preview.duration)} giây` : 'thời lượng chưa xác định';
    els.videoDetails.textContent = `${formatBytes(file.size)} · ${duration}`;
    if (!els.title.value.trim()) els.title.value = file.name.replace(/\.[^.]+$/, '');
  }, { once: true });
  renderProjectStatus();
}

function clearSelectedFile() {
  state.selectedFile = null;
  els.fileInput.value = '';
  els.fileInput.disabled = false;
  els.dropzone.classList.remove('locked');
  els.preview.pause();
  els.preview.removeAttribute('src');
  els.preview.load();
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = null;
  els.previewWrap.classList.add('hidden');
  els.dropzone.classList.remove('hidden');
  els.uploadTitle.textContent = 'Thả video vào đây';
  els.uploadSubtitle.innerHTML = 'hoặc <u>chọn tệp từ máy tính</u>';
  els.dropzone.querySelector('.upload-icon').innerHTML = '<span>↑</span>';
  renderProjectStatus();
}

async function startNewProject() {
  if (!state.selectedFile) return showToast('Trước tiên hãy chọn video nguồn.');
  if (!state.status?.openai.available) return showToast(state.status?.openai.reason || 'AI Local Server chưa sẵn sàng.');
  const title = els.title.value.trim();
  if (!title) return showToast('Hãy nhập tên dự án.');
  const mode = document.querySelector('input[name="edit-mode"]:checked').value;
  els.run.disabled = true;
  els.run.textContent = 'Đang tạo workspace…';
  try {
    let project = state.project;
    if (project) {
      const updated = await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, prompt: els.prompt.value.trim(), editMode: mode }),
      });
      project = updated.project;
      setProject(project);
    } else {
      const created = await api('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, prompt: els.prompt.value.trim(), editMode: mode }),
      });
      project = created.project;
      setProject(project);
    }
    const file = state.selectedFile;
    const encodedName = encodeURIComponent(file.name);
    els.run.textContent = 'Đang tải video lên…';
    await api(`/api/projects/${project.id}/media`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodedName },
      body: file,
    });
    state.selectedFile = null;
    await loadProject(project.id);
    await beginRun();
  } catch (error) {
    showToast(error.message);
    renderProjectStatus();
  }
}

async function beginRun() {
  if (!state.project) return;
  els.run.disabled = true;
  els.run.textContent = 'Đang khởi chạy AI…';
  try {
    const editMode = document.querySelector('input[name="edit-mode"]:checked').value;
    await api(`/api/projects/${state.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: els.title.value.trim(),
        prompt: els.prompt.value.trim(),
        editMode,
      }),
    });
    await api(`/api/projects/${state.project.id}/run`, { method: 'POST' });
    await loadProject(state.project.id);
    connectEvents(state.project.id);
  } catch (error) {
    showToast(error.message);
    await loadProject(state.project.id).catch(() => {});
  } finally {
    els.run.innerHTML = '<span>✳</span> Bắt đầu dựng với AI <b>→</b>';
    renderProjectStatus();
  }
}

async function loadProject(id) {
  const result = await api(`/api/projects/${id}`);
  setProject(result.project);
  await loadProjects();
  connectEvents(id);
}

async function openProject(id) {
  try {
    clearSelectedFile();
    resetLog();
    await loadProject(id);
  } catch (error) {
    showToast(error.message);
  }
}

function connectEvents(id) {
  state.events?.close();
  const events = new EventSource(`/api/projects/${id}/events`);
  state.events = events;
  events.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    if (event.type === 'project') {
      setProject(event.project);
      if (event.project.status !== 'running') events.close();
    } else if (event.type === 'log') {
      appendLog(event.text, event.stream);
    } else if (event.type === 'snapshot') {
      resetLog();
      appendLog(event.text);
    } else if (event.type === 'error') {
      appendLog(event.message, 'stderr');
    }
    refreshOutputs();
    loadProjects().catch(() => {});
  };
  events.onerror = () => {
    if (state.project?.status !== 'running') events.close();
  };
}

async function refreshOutputs() {
  if (!state.project) {
    els.outputList.replaceChildren();
    return;
  }
  try {
    const result = await api(`/api/projects/${state.project.id}/files`);
    els.outputList.replaceChildren();
    for (const file of result.files) {
      const link = document.createElement('a');
      link.className = 'output-link';
      link.href = `/api/projects/${state.project.id}/file?path=${encodeURIComponent(file.path)}`;
      link.target = '_blank';
      link.rel = 'noreferrer';
      const icon = document.createElement('span');
      icon.textContent = file.type === '.mp4' ? '▶' : '↧';
      const name = document.createElement('span');
      name.textContent = file.path;
      const size = document.createElement('span');
      size.textContent = formatBytes(file.bytes);
      link.append(icon, name, size);
      els.outputList.append(link);
    }
  } catch (error) {
    showToast(`Không tải được danh sách file: ${error.message}`);
  }
}

async function cancelRun() {
  if (!state.project) return;
  els.cancel.disabled = true;
  try {
    await api(`/api/projects/${state.project.id}/cancel`, { method: 'POST' });
    showToast('Đã gửi yêu cầu dừng tác vụ.');
  } catch (error) {
    showToast(error.message);
  } finally {
    els.cancel.disabled = false;
  }
}

async function initialize() {
  try {
    state.status = await api('/api/status');
    els.engineDot.classList.toggle('ok', state.status.openai.available);
    els.engineDot.classList.toggle('bad', !state.status.openai.available);
    els.engineStatus.textContent = state.status.openai.available
      ? `OpenAI-compatible · ${state.status.openai.model}`
      : state.status.openai.reason;
  } catch (error) {
    els.engineDot.classList.add('bad');
    els.engineStatus.textContent = error.message;
  }
  try {
    await loadProjects();
    const projects = state.projects;
    if (projects.length) {
      const running = projects.find((project) => project.status === 'running');
      await loadProject((running || projects[0]).id);
    }
  } catch (error) {
    showToast(`Không tải được workspace: ${error.message}`);
  }
  renderProjectStatus();
}

els.fileInput.addEventListener('change', () => setFile(els.fileInput.files[0]));
els.dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.dropzone.classList.add('dragging');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragging'));
els.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  els.dropzone.classList.remove('dragging');
  if (!els.fileInput.disabled) setFile(event.dataTransfer.files[0]);
});
$('#remove-video').addEventListener('click', clearSelectedFile);
$('#new-project-button').addEventListener('click', () => {
  state.events?.close();
  state.project = null;
  resetLog();
  els.breadcrumb.textContent = 'Studio';
  els.title.value = '';
  els.prompt.value = '';
  els.promptCount.textContent = '0 / 10000';
  els.outputList.replaceChildren();
  clearSelectedFile();
  renderProjectList();
});
document.querySelectorAll('.mode-card input').forEach((input) => input.addEventListener('change', updateModeSelection));
els.prompt.addEventListener('input', () => { els.promptCount.textContent = `${els.prompt.value.length} / 10000`; });
els.run.addEventListener('click', () => state.project?.sourcePath ? beginRun() : startNewProject());
els.cancel.addEventListener('click', cancelRun);
$('#clear-log').addEventListener('click', resetLog);
initialize();

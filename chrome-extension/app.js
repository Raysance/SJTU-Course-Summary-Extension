const $ = selector => document.querySelector(selector);
const state = {
  tab: null,
  coursePages: [],
  selectedPageKey: null,
  replays: [],
  metadata: {},
  files: [],
  selectedFileIds: new Set(),
  filesRunning: false,
  videoLoading: false,
  running: false,
  previewCache: new Map(),
  previewShowTimer: null,
  previewHideTimer: null,
  pendingDownload: null
};

const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    keyPlaceholder: "sk-...",
    storageKey: "deepseekApiKey"
  },
  openai: {
    label: "ChatGPT / OpenAI",
    defaultModel: "gpt-4.1-mini",
    keyPlaceholder: "sk-...",
    storageKey: "openaiApiKey"
  },
  anthropic: {
    label: "Claude / Anthropic",
    defaultModel: "claude-sonnet-4-5-20250929",
    keyPlaceholder: "sk-ant-...",
    storageKey: "anthropicApiKey"
  },
  gemini: {
    label: "Gemini / Google",
    defaultModel: "gemini-2.5-flash",
    keyPlaceholder: "AIza...",
    storageKey: "geminiApiKey"
  }
};

const CLASS_VIDEO_TOOL_ID = "8329";
const REQUESTED_COURSE_ID = new URLSearchParams(location.search).get("courseId") || "";

const PROMPT_TEMPLATES = {
  notes: {
    label: "课堂笔记",
    extension: "md",
    maxOutputTokens: 5000,
    continuationRounds: 1,
    prompt: `你是课堂笔记整理助手。请根据课堂概要、章节导航和字幕，整理一份适合复习与回顾的中文 Markdown 课堂笔记。

要求：
1. 使用“总 / 分”的结构呈现。
2. “总”部分概括本次课的主题、主线、核心结论和学习重点。
3. “分”部分按知识模块整理，每个模块包含关键概念、老师强调点、逻辑关系、例子或易混点。
4. 不需要输出原字幕，不要逐句转写。
5. 不需要强调页码整理；只有材料中明确出现页码时才可自然提及。
6. 表达简明、层次清楚，适合直接作为课堂笔记保存。
7. 课堂字幕可能存在语音识别错误；遇到明显错字、断句或同音误识别时，请结合上下文和课程语境合理纠正。
8. 只依据提供的课堂材料整理，不补充材料外的信息。`
  },
  review: {
    label: "复习资料",
    extension: "md",
    maxOutputTokens: 6000,
    continuationRounds: 1,
    prompt: `这节课是给期末考试划重点。请根据课堂概要、章节导航和字幕，生成一份可直接用于期末复习的中文 Markdown 复习资料。

要求：
1. 层级、脉络和分点必须清晰，适合作为复习时的唯一参考来源。
2. 对老师提到的页码、章节、题型、参考位置、教材位置或其他定位信息，请在整理中明确标出。
3. 对字幕中提到但没有具体解释的知识点，请使用你的学科知识补全必要背景、定义、公式、结论、答题表述或例子。
4. 区分“老师明确强调的内容”和“为复习补全的内容”，但不要让结构变得冗长。
5. 对重点、易错点、可能考法、答题关键词进行归纳。
6. 课堂字幕可能存在语音识别错误；遇到明显错字、断句或同音误识别时，请结合上下文和课程语境合理纠正。
7. 输出应完整、清晰、可直接保存为复习资料。`
  },
  latex: {
    label: "LaTeX 笔记",
    extension: "tex",
    maxOutputTokens: 8000,
    continuationRounds: 4,
    prompt: `请根据课堂概要、章节导航、字幕以及用户追加 Prompt 中可能提供的参考模板，生成一份完整的 LaTeX 笔记源码。不要使用 Markdown 代码块包裹输出，只输出可保存为 .tex 的内容。

通用要求：
1. 如果用户在追加 Prompt 中提供了 LaTeX 参考模板，请尽量遵循该模板的文档结构、宏包、环境、标题样式和排版习惯。
2. 如果没有提到署名或作者，请将作者位置留空或省略作者，不要编造署名。
3. 内容需要完善：补全课堂中提到但未完整记录的要点；对重要概念、结论、方法、性质、定理或步骤给出清晰解释。
4. 准确性优先：修正不规范或明显错误的符号、术语和表述；笔记中提到的所有内容都应在文档中体现。
5. 结构化：分点清晰，脉络连贯；在多种术语或符号可选时，选择最常用的表述，并保持全文一致。
6. 排版规范：LaTeX 格式美观，缩进和换行正确。
7. 课堂字幕可能存在语音识别错误；遇到明显错字、断句或同音误识别时，请结合上下文和课程语境合理纠正。

若课程内容偏数学，请额外满足：
1. 对所有定理及性质给出直观理解、提出动机和原因。
2. 每个定理、定义和性质必须表述明确，不要有歧义。
3. 证明过程完整严谨，不跳步，不用“显然”等省略性表述，不默认读者已经掌握关键步骤。
4. 不用不严谨的比喻替代证明或定义。`
  }
};

function log(message) {
  const now = new Date().toLocaleTimeString("zh-CN", {hour12: false});
  $("#log").textContent += `\n[${now}] ${message}`;
  $("#log").scrollTop = $("#log").scrollHeight;
}

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

function reportCaughtError(context, error, options = {}) {
  const message = `${context}：${errorMessage(error)}`;
  console.error(`[SJTU Course Helper] ${message}`, error);
  if (options.ui) log(message);
  return message;
}

function setRunning(running) {
  state.running = running;
  $("#export-selected").disabled = running || !state.replays.length;
  $("#refresh").disabled = running;
  $("#select-all-days").disabled = running || !state.replays.length;
  $("#clear-days").disabled = running || !state.replays.length;
  document.querySelectorAll(".day-check").forEach(input => input.disabled = running);
  updateFileControls();
  updateVideoControls();
}

function currentProvider() {
  const id = $("#provider").value;
  return {id, ...PROVIDERS[id]};
}

function progress(done, total, title) {
  $("#progress-title").textContent = title;
  $("#progress-count").textContent = `${done} / ${total}`;
  $("#bar").style.width = total ? `${Math.round(done * 100 / total)}%` : "0";
}

function safeName(value) {
  return (value || "课堂概要").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

function safePathPart(value) {
  return safeName(value).replace(/^\.+$/, "-") || "未命名";
}

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(href, base = "https://oc.sjtu.edu.cn/") {
  try {
    return new URL(href, base).href;
  } catch (error) {
    reportCaughtError(`URL 解析失败 ${href || ""}`.trim(), error);
    return "";
  }
}

function stableKey(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function canvasCourseId(url) {
  return absoluteUrl(url).match(/\/courses\/(\d+)/)?.[1] || "";
}

function selectedCoursePage() {
  return state.coursePages.find(item => item.key === state.selectedPageKey) || null;
}

function selectedCourseId() {
  const page = selectedCoursePage();
  return page?.courseId || canvasCourseId(page?.canvasUrl || "") || REQUESTED_COURSE_ID;
}

function currentCourseName(fallback = "SJTU课程") {
  return selectedCoursePage()?.metadata?.course || state.metadata.course || fallback;
}

function currentCourseTerm() {
  return selectedCoursePage()?.metadata?.term || state.metadata.term || "";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classVideoLink(course) {
  return {
    url: `https://oc.sjtu.edu.cn/courses/${course.id}/external_tools/${CLASS_VIDEO_TOOL_ID}?display=borderless`,
    course: course.course || course.name || `课程 ${course.id}`,
    courseId: String(course.id),
    term: course.term || "",
    label: "课堂视频new"
  };
}

function normalizeCanvasCourse(raw) {
  const id = raw.id || raw.course_id || canvasCourseId(raw.href || raw.html_url || raw.url || "");
  if (!id) return null;
  const term = typeof raw.term === "string" ? raw.term : (raw.term?.name || raw.enrollment_term?.name || "");
  const course = cleanText(
    raw.shortName ||
    raw.short_name ||
    raw.originalName ||
    raw.original_name ||
    raw.nickname ||
    raw.name ||
    raw.course_code ||
    raw.course ||
    `课程 ${id}`
  );
  return {id: String(id), course, term};
}

function canvasApiNextUrl(linkHeader) {
  const next = (linkHeader || "").split(",").find(part => /rel="next"/.test(part));
  return next?.match(/<([^>]+)>/)?.[1] || "";
}

async function fetchCanvasApiPages(url, limit = 3) {
  const items = [];
  let nextUrl = url;
  for (let page = 0; nextUrl && page < limit; page++) {
    const response = await fetch(nextUrl, {credentials: "include"});
    if (!response.ok) throw new Error(`Canvas API 请求失败（${response.status}）`);
    const data = await response.json();
    if (Array.isArray(data)) items.push(...data);
    else if (data) items.push(data);
    nextUrl = canvasApiNextUrl(response.headers.get("link"));
  }
  return items;
}

function fileDownloadUrl(file) {
  if (file.downloadUrl) return file.downloadUrl;
  if (file.url && /\/files\/\d+\/download/.test(file.url)) return file.url;
  return `https://oc.sjtu.edu.cn/files/${file.id}/download?download_frd=1`;
}

function normalizeCanvasFile(raw, folderPath = "") {
  const id = raw.id || raw.file_id;
  if (!id) return null;
  const name = cleanText(raw.display_name || raw.filename || raw.name || `文件 ${id}`);
  return {
    id: String(id),
    name,
    path: [folderPath, name].filter(Boolean).join("/"),
    size: Number(raw.size || 0),
    sizeText: raw.size ? formatBytes(Number(raw.size)) : "",
    updatedAt: raw.updated_at || raw.modified_at || "",
    downloadUrl: fileDownloadUrl({id, url: raw.url}),
    source: "canvas-api"
  };
}

function normalizeCanvasFolder(raw, parentPath = "") {
  const id = raw.id || raw.folder_id;
  if (!id) return null;
  const name = cleanText(raw.name || raw.full_name?.split("/").pop() || `文件夹 ${id}`);
  return {
    id: String(id),
    name,
    path: [parentPath, name].filter(Boolean).join("/")
  };
}

async function discoverCoursesByApi() {
  const rows = await fetchCanvasApiPages("https://oc.sjtu.edu.cn/api/v1/courses?enrollment_state=active&include[]=term&per_page=100");
  const seen = new Map();
  for (const row of rows) {
    const course = normalizeCanvasCourse(row);
    if (course) seen.set(course.id, course);
  }
  return [...seen.values()];
}

async function discoverCanvasVideoLinks() {
  const apiCourses = await discoverCoursesByApi();
  if (!apiCourses.length) throw new Error("Canvas API 未返回本学期课程，请确认已经登录 oc.sjtu.edu.cn。");
  log(`已通过 Canvas API 识别 ${apiCourses.length} 门课程。`);
  return apiCourses.map(classVideoLink).sort((a, b) => a.course.localeCompare(b.course, "zh-Hans-CN"));
}

async function discoverCourseFilesByApi(courseId) {
  const root = (await fetchCanvasApiPages(`https://oc.sjtu.edu.cn/api/v1/courses/${courseId}/folders/root`, 1))[0];
  const rootFolder = normalizeCanvasFolder(root, "");
  if (!rootFolder) throw new Error("Canvas API 未返回课程根文件夹。");
  const files = [];
  const queue = [{id: rootFolder.id, path: ""}];
  const visited = new Set();
  while (queue.length) {
    const folder = queue.shift();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    const [folderFiles, childFolders] = await Promise.all([
      fetchCanvasApiPages(`https://oc.sjtu.edu.cn/api/v1/folders/${folder.id}/files?per_page=100`, 20),
      fetchCanvasApiPages(`https://oc.sjtu.edu.cn/api/v1/folders/${folder.id}/folders?per_page=100`, 20)
    ]);
    for (const rawFile of folderFiles) {
      const file = normalizeCanvasFile(rawFile, folder.path);
      if (file) files.push(file);
    }
    for (const rawFolder of childFolders) {
      const child = normalizeCanvasFolder(rawFolder, folder.path);
      if (child) queue.push(child);
    }
    if (visited.size > 300) throw new Error("课程文件夹层级过多，已停止自动递归。");
  }
  return files;
}

async function discoverCourseFilesFlat(courseId) {
  const rows = await fetchCanvasApiPages(`https://oc.sjtu.edu.cn/api/v1/courses/${courseId}/files?per_page=100`, 50);
  return rows.map(row => normalizeCanvasFile(row)).filter(Boolean);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function timestampName() {
  const date = new Date();
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

async function courseTab() {
  if (state.tab?.id) return state.tab;
  await discoverCoursePages();
  const page = state.coursePages.find(item => item.key === state.selectedPageKey);
  if (!page) throw new Error("未找到课堂视频入口，请确认已经登录 oc.sjtu.edu.cn。");
  return (await resolveCoursePage(page)).tab;
}

async function filesTab(courseId, {reuse = true} = {}) {
  const url = `https://oc.sjtu.edu.cn/courses/${courseId}/files`;
  const existing = reuse ? await chrome.tabs.query({url: `${url}*`}) : [];
  if (existing.length) return existing[0];
  return chrome.tabs.create({url, active: false});
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) {
      reportCaughtError("课堂视频页消息发送失败", error);
      throw error;
    }
    reportCaughtError("课堂视频页消息发送失败，正在注入内容脚本", error);
    await chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]});
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function sendToFilesTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) {
      reportCaughtError("课程文件页消息发送失败", error);
      throw error;
    }
    reportCaughtError("课程文件页消息发送失败，正在注入内容脚本", error);
    await chrome.scripting.executeScript({target: {tabId}, files: ["files-content.js"]});
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function send(message) {
  return sendToTab(state.tab.id, message);
}

async function discoverCoursePages() {
  const links = await discoverCanvasVideoLinks();
  const pages = links.map((link, index) => ({
    kind: "canvas",
    key: `canvas-${link.courseId || index}-${stableKey(link.url)}`,
    canvasUrl: link.url,
    courseId: link.courseId || canvasCourseId(link.url),
    replays: [],
    metadata: {course: link.course, teacher: "", entryLabel: link.label},
    tab: null
  }));
  state.coursePages = pages;
  if (!pages.length) {
    state.selectedPageKey = null;
    return;
  }
  if (!pages.some(page => page.key === state.selectedPageKey)) {
    const requested = REQUESTED_COURSE_ID && pages.find(page => page.courseId === REQUESTED_COURSE_ID);
    state.selectedPageKey = requested ? requested.key : (pages.length === 1 ? pages[0].key : null);
  }
}

function renderCoursePages() {
  const select = $("#course-pages");
  select.textContent = "";
  if (!state.selectedPageKey && state.coursePages.length > 1) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择课程";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);
  }
  state.coursePages.forEach((page, index) => {
    const option = document.createElement("option");
    option.value = page.key;
    const course = page.metadata.course || page.tab?.title || `课堂页面 ${index + 1}`;
    const teacher = page.metadata.teacher ? ` · ${page.metadata.teacher}` : "";
    const count = page.replays?.length ? ` · ${page.replays.length} 回放` : "";
    option.textContent = `${course}${teacher}${count}`;
    select.append(option);
  });
  select.value = state.selectedPageKey || "";
  select.classList.toggle("hidden", state.coursePages.length <= 1);
}

async function resolveCoursePage(page) {
  if (page.tab?.id && page.replays?.length) return page;
  log(`正在打开 ${page.metadata.course || "课程"} 的课堂视频入口…`);
  const tab = await chrome.tabs.create({url: page.canvasUrl, active: false});
  await chrome.tabs.update(tab.id, {muted: true}).catch(error => reportCaughtError("课堂视频标签页静音失败", error));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id).catch(error => {
      reportCaughtError("读取课堂视频标签页状态失败", error);
      return null;
    });
    if (!current) throw new Error("课堂视频标签页已关闭。");
    if (current.url?.includes("v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/")) {
      await chrome.tabs.update(current.id, {muted: true}).catch(error => reportCaughtError("课堂视频标签页静音失败", error));
      try {
        const reply = await sendToTab(current.id, {action: "listReplays"});
        if (reply?.replays?.length) {
          page.tab = current;
          page.replays = reply.replays;
          page.metadata = {...page.metadata, ...(reply.metadata || {})};
          return page;
        }
      } catch (error) {
        reportCaughtError("课堂视频页脚本暂未响应", error);
      }
    }
    await wait(1000);
  }
  throw new Error("已找到课堂视频入口，但视频页未在 45 秒内加载出回放列表。");
}

async function loadCourse() {
  if (state.running) return;
  $("#log").textContent = "正在识别课程…";
  try {
    await discoverCoursePages();
    renderCoursePages();
    if (!state.selectedPageKey && state.coursePages.length > 1) {
      const count = state.coursePages.length;
      $("#course").textContent = "请选择课程";
      $("#meta").textContent = `已识别 ${count} 门课程。`;
      state.tab = null;
      state.replays = [];
      state.metadata = {};
      state.previewCache.clear();
      state.files = [];
      state.selectedFileIds.clear();
      renderDayChecks(new Map());
      renderFiles();
      $("#export-selected").disabled = true;
      $("#select-all-days").disabled = true;
      $("#clear-days").disabled = true;
      updateVideoControls();
      progress(0, count, "等待选择课程");
      $("#video-meta").textContent = "选择课程后读取课堂视频。";
      $("#log").textContent = "已完成课程识别，请在顶部选择课程。";
      return;
    }
    const page = selectedCoursePage();
    if (!page) throw new Error("未找到课堂视频入口，请确认已经登录 oc.sjtu.edu.cn。");
    state.metadata = page.metadata || {};
    $("#course").textContent = currentCourseName("SJTU 课程");
    $("#meta").textContent = `${currentCourseTerm() || "学期信息未显示"} · 文件打包与视频概要已分模块处理`;
    resetVideoModule("等待读取课堂视频。");
    state.files = [];
    state.selectedFileIds.clear();
    renderFiles();
    await loadFiles({quiet: true});
    await loadVideo({quiet: true});
    $("#meta").textContent = `${currentCourseTerm() || "学期信息未显示"} · ${state.files.length} 个文件 · ${state.replays.length} 个回放`;
    $("#log").textContent = "课程读取成功。文件下载与视频概要可分别操作。";
  } catch (error) {
    reportCaughtError("课程读取失败", error);
    $("#course").textContent = "未连接到课程页面";
    $("#meta").textContent = error.message;
    $("#log").textContent = error.message;
  }
}

function groupReplays(replays) {
  const groups = new Map();
  for (const replay of replays) {
    const day = replay.time.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(replay);
  }
  return groups;
}

function renderDayChecks(grouped) {
  const list = $("#day-list");
  list.classList.remove("muted");
  list.textContent = "";
  if (!grouped.size) {
    list.classList.add("muted");
    list.textContent = selectedCourseId() ? "等待课堂视频。" : "等待选择课程。";
    return;
  }
  for (const day of [...grouped.keys()].sort().reverse()) {
    const label = document.createElement("label");
    label.className = "day-item";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "day-check";
    input.value = day;
    input.checked = true;
    const text = document.createElement("span");
    text.textContent = `${day}（${grouped.get(day).length} 段）`;
    label.addEventListener("mouseenter", () => schedulePreview(day, label));
    label.addEventListener("mouseleave", hidePreviewSoon);
    label.append(input, text);
    list.append(label);
  }
}

function updateVideoControls() {
  const loading = state.videoLoading || state.running;
  $("#refresh-video").disabled = loading || !selectedCourseId();
  $("#export-selected").disabled = loading || state.running || !state.replays.length;
  $("#select-all-days").disabled = loading || state.running || !state.replays.length;
  $("#clear-days").disabled = loading || state.running || !state.replays.length;
  document.querySelectorAll(".day-check").forEach(input => input.disabled = loading || state.running);
}

function resetVideoModule(message = "等待课堂视频。") {
  state.tab = null;
  state.replays = [];
  state.previewCache.clear();
  renderDayChecks(new Map());
  $("#video-meta").textContent = message;
  progress(0, 0, "视频未读取");
  updateVideoControls();
}

async function loadVideo({quiet = false} = {}) {
  if (state.running || state.videoLoading) return;
  const page = selectedCoursePage();
  if (!page) {
    resetVideoModule("请选择课程后读取课堂视频。");
    return;
  }
  state.videoLoading = true;
  state.tab = null;
  state.replays = [];
  state.previewCache.clear();
  renderDayChecks(new Map());
  $("#video-meta").textContent = "正在读取课堂视频回放…";
  progress(0, 0, "读取课堂视频");
  updateVideoControls();
  if (!quiet) log(`正在读取 ${currentCourseName("课程")} 的课堂视频…`);
  try {
    await resolveCoursePage(page);
    renderCoursePages();
    if (!page.replays?.length) throw new Error("页面尚未加载出回放列表，请稍后重试。");
    state.tab = page.tab;
    state.replays = page.replays;
    state.metadata = {...state.metadata, ...(page.metadata || {})};
    const grouped = groupReplays(state.replays);
    renderDayChecks(grouped);
    $("#video-meta").textContent = `${state.replays.length} 个回放 · ${grouped.size} 个上课日`;
    progress(0, state.replays.length, "视频准备就绪");
    if (!quiet) log("课堂视频读取成功。可勾选一个或多个日期，也可以全选。");
  } catch (error) {
    resetVideoModule(`课堂视频读取失败：${error.message}`);
    reportCaughtError("课堂视频读取失败", error, {ui: !quiet});
  } finally {
    state.videoLoading = false;
    updateVideoControls();
  }
}

function selectedDays() {
  return new Set([...document.querySelectorAll(".day-check:checked")].map(input => input.value));
}

function selectedFiles() {
  return state.files.filter(file => state.selectedFileIds.has(file.id));
}

function filteredFiles() {
  const keyword = cleanText($("#file-search").value).toLowerCase();
  if (!keyword) return state.files;
  return state.files.filter(file => `${file.name} ${file.path}`.toLowerCase().includes(keyword));
}

function updateFileControls() {
  const hasFiles = !!state.files.length;
  const running = state.running || state.filesRunning;
  $("#refresh-files").disabled = running || !selectedCourseId();
  $("#file-search").disabled = running || !hasFiles;
  $("#select-all-files").disabled = running || !hasFiles;
  $("#clear-files").disabled = running || !hasFiles;
  $("#download-files").disabled = running || !selectedFiles().length;
  document.querySelectorAll(".file-check").forEach(input => input.disabled = running);
}

function renderFiles() {
  const list = $("#file-list");
  const visible = filteredFiles();
  list.textContent = "";
  list.classList.toggle("muted", !visible.length);
  if (!state.files.length) {
    list.textContent = selectedCourseId() ? "未读取到课程文件。" : "等待选择课程。";
    $("#files-meta").textContent = selectedCourseId() ? "可尝试打开课程文件页后重新读取。" : "选择课程后自动读取文件。";
    updateFileControls();
    return;
  }
  if (!visible.length) {
    list.textContent = "没有匹配的文件。";
    $("#files-meta").textContent = `已读取 ${state.files.length} 个文件，当前筛选 0 个。`;
    updateFileControls();
    return;
  }
  const selectedCount = selectedFiles().length;
  $("#files-meta").textContent = `已读取 ${state.files.length} 个文件，已选 ${selectedCount} 个。`;
  for (const file of visible) {
    const label = document.createElement("label");
    label.className = "file-item";
    label.title = file.path || file.name;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "file-check";
    input.value = file.id;
    input.checked = state.selectedFileIds.has(file.id);
    input.addEventListener("change", () => {
      if (input.checked) state.selectedFileIds.add(file.id);
      else state.selectedFileIds.delete(file.id);
      updateFileControls();
      $("#files-meta").textContent = `已读取 ${state.files.length} 个文件，已选 ${selectedFiles().length} 个。`;
    });

    const body = document.createElement("div");
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name;
    const path = document.createElement("div");
    path.className = "file-path";
    path.textContent = file.path && file.path !== file.name ? file.path : "课程根目录";
    body.append(name, path);

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = file.sizeText || "";
    label.append(input, body, size);
    list.append(label);
  }
  updateFileControls();
}

async function scanFilesDomTab(tab, courseId, url) {
  await chrome.tabs.update(tab.id, {url, active: false});
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id).catch(error => {
      reportCaughtError("读取课程文件标签页状态失败", error);
      return null;
    });
    if (!current) throw new Error("课程文件标签页已关闭。");
    if (current.status === "complete" || current.url?.includes(`/courses/${courseId}/files`)) {
      try {
        const reply = await sendToFilesTab(current.id, {action: "scanCanvasFiles"});
        if (reply?.files?.length || reply?.folders?.length) {
          return {
            ...reply,
            files: (reply.files || []).map(file => ({
              ...file,
              id: String(file.id),
              path: file.path || file.name,
              downloadUrl: absoluteUrl(file.downloadUrl)
            }))
          };
        }
      } catch (error) {
        reportCaughtError("课程文件页脚本暂未响应", error);
      }
    }
    await wait(500);
  }
  throw new Error("课程文件页未在 20 秒内加载出文件清单。");
}

async function discoverCourseFilesFromDom(courseId) {
  const tab = await filesTab(courseId, {reuse: false});
  const startUrl = `https://oc.sjtu.edu.cn/courses/${courseId}/files`;
  const queue = [startUrl];
  const visited = new Set();
  const files = [];
  try {
    while (queue.length) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      const reply = await scanFilesDomTab(tab, courseId, url);
      files.push(...(reply.files || []));
      for (const folder of reply.folders || []) {
        if (folder.href && !visited.has(folder.href)) queue.push(folder.href);
      }
      if (visited.size > 80) throw new Error("文件夹数量过多，已停止页面递归识别。");
    }
    return mergeFiles(files);
  } finally {
    await chrome.tabs.remove(tab.id).catch(error => reportCaughtError("关闭临时课程文件标签页失败", error));
  }
}

function mergeFiles(files) {
  const seen = new Map();
  for (const file of files) {
    if (!file?.id) continue;
    seen.set(String(file.id), {...file, id: String(file.id)});
  }
  return [...seen.values()].sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, "zh-Hans-CN"));
}

async function loadFiles({quiet = false} = {}) {
  const courseId = selectedCourseId();
  if (!courseId || state.filesRunning) return;
  state.filesRunning = true;
  updateFileControls();
  $("#file-list").classList.add("muted");
  $("#file-list").textContent = "正在读取课程文件…";
  if (!quiet) log("正在读取课程文件…");
  try {
    let files = [];
    try {
      files = await discoverCourseFilesByApi(courseId);
      if (!files.length) files = await discoverCourseFilesFlat(courseId);
    } catch (apiError) {
      reportCaughtError("Canvas API 读取失败，改用当前文件页识别", apiError, {ui: !quiet});
      files = await discoverCourseFilesFromDom(courseId);
    }
    if (!files.length) {
      files = await discoverCourseFilesFromDom(courseId);
    }
    state.files = mergeFiles(files);
    state.selectedFileIds = new Set(state.files.map(file => file.id));
    renderFiles();
    if (!quiet) log(`已读取 ${state.files.length} 个课程文件。`);
  } catch (error) {
    state.files = [];
    state.selectedFileIds.clear();
    $("#file-list").classList.add("muted");
    $("#file-list").textContent = `读取失败：${error.message}`;
    $("#files-meta").textContent = "课程文件读取失败。";
    reportCaughtError("课程文件读取失败", error, {ui: !quiet});
  } finally {
    state.filesRunning = false;
    updateFileControls();
  }
}

async function fetchCourseFileBytes(file, courseId) {
  const downloadUrl = fileDownloadUrl(file);
  const backgroundReply = await chrome.runtime.sendMessage({
    action: "fetchCanvasFileInBackground",
    downloadUrl
  });
  if (backgroundReply?.base64) return base64ToBytes(backgroundReply.base64);

  const tab = await filesTab(courseId);
  const pageReply = await sendToFilesTab(tab.id, {
    action: "fetchCanvasFile",
    downloadUrl
  });
  if (pageReply?.base64) return base64ToBytes(pageReply.base64);
  throw new Error(backgroundReply?.error || pageReply?.error || "未返回文件内容。");
}

async function downloadSelectedFiles() {
  if (state.filesRunning) return;
  const files = selectedFiles();
  if (!files.length) {
    log("请至少勾选一个课程文件。");
    return;
  }
  state.filesRunning = true;
  updateFileControls();
  const folder = safePathPart(currentCourseName("SJTU课程文件"));
  $("#files-meta").textContent = `正在打包 ${files.length} 个文件…`;
  log(`开始读取并打包 ${files.length} 个课程文件。`);
  const zipEntries = [];
  let failed = 0;
  const usedNames = new Set();
  const courseId = selectedCourseId();
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    progress(index, files.length, `读取课程文件 ${index + 1} / ${files.length}`);
    try {
      const bytes = await fetchCourseFileBytes(file, courseId);
      const filename = uniquifyZipName((file.path || file.name).split("/").map(safePathPart).join("/"), usedNames);
      zipEntries.push({name: filename, bytes});
    } catch (error) {
      failed++;
      reportCaughtError(`读取失败 ${file.name}`, error, {ui: true});
    }
  }
  try {
    if (!zipEntries.length) throw new Error("没有成功读取的文件。");
    progress(zipEntries.length, files.length, "正在生成 ZIP");
    await downloadZipNow(`${folder}-课程文件-${timestampName()}.zip`, zipEntries);
    $("#files-meta").textContent = `已打包下载 ${zipEntries.length} 个文件${failed ? `，失败 ${failed} 个` : ""}。`;
    log(`课程文件 ZIP 已下载：包含 ${zipEntries.length} 个文件${failed ? `，失败 ${failed} 个` : ""}。`);
  } catch (error) {
    $("#files-meta").textContent = `打包失败：${error.message}`;
    reportCaughtError("课程文件打包失败", error, {ui: true});
  } finally {
    state.filesRunning = false;
    updateFileControls();
  }
}

function captionsMarkdown(day, lessons) {
  const lines = [
    `# ${currentCourseName("课堂")} · ${day} 原字幕`,
    "",
    `> 教师：${state.metadata.teacher || "未显示"}  `,
    `> 当日回放：${lessons.length} 段  `,
    ""
  ];
  lessons.forEach((lesson, index) => {
    lines.push(`## 第 ${index + 1} 段 · ${lesson.time.slice(11, 16)}`, "");
    if (lesson.captions?.length) {
      lesson.captions.forEach(item => lines.push(`- \`${item.start}\` ${item.text}`));
    } else {
      lines.push("本段未读取到字幕。");
    }
    lines.push("");
  });
  return lines.join("\n");
}

function captionsPreview(lessons, limit = 1300) {
  const chunks = [];
  for (const lesson of lessons) {
    chunks.push(`【${lesson.time.slice(11, 16)}】`);
    const rows = lesson.captions || [];
    for (const item of rows.slice(0, 20)) chunks.push(`${item.start} ${item.text}`);
  }
  const text = chunks.join("\n").trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text || "未读取到字幕。";
}

function ensurePreviewBox() {
  let box = $("#preview-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "preview-box";
    box.className = "preview-box hidden";
    box.addEventListener("mouseenter", () => clearTimeout(state.previewHideTimer));
    box.addEventListener("mouseleave", hidePreviewSoon);
    document.body.append(box);
  }
  return box;
}

function showPreview(anchor, text) {
  const box = ensurePreviewBox();
  const rect = anchor.getBoundingClientRect();
  box.textContent = text;
  box.style.left = `${Math.min(rect.left, window.innerWidth - 430)}px`;
  box.style.top = `${rect.bottom + 8 + window.scrollY}px`;
  box.classList.remove("hidden");
}

function hidePreview() {
  clearTimeout(state.previewShowTimer);
  clearTimeout(state.previewHideTimer);
  const box = $("#preview-box");
  if (box) box.classList.add("hidden");
}

function hidePreviewSoon() {
  clearTimeout(state.previewShowTimer);
  clearTimeout(state.previewHideTimer);
  state.previewHideTimer = setTimeout(hidePreview, 380);
}

function schedulePreview(day, anchor) {
  clearTimeout(state.previewShowTimer);
  clearTimeout(state.previewHideTimer);
  state.previewShowTimer = setTimeout(() => showDayPreview(day, anchor), 650);
}

async function showDayPreview(day, anchor) {
  if (state.running) return;
  if (state.previewCache.has(day)) {
    showPreview(anchor, state.previewCache.get(day));
    return;
  }
  showPreview(anchor, "正在读取当天字幕预览…");
  try {
    state.tab = await courseTab();
    const replays = state.replays.filter(item => item.time.slice(0, 10) === day);
    const {lessons} = await collect(replays, {silent: true});
    const preview = captionsPreview(lessons);
    state.previewCache.set(day, preview);
    showPreview(anchor, preview);
  } catch (error) {
    reportCaughtError("当天字幕预览失败", error);
    showPreview(anchor, `预览失败：${error.message}`);
  }
}

function aiSource(lessons) {
  const sections = lessons.map((lesson, index) => {
    const summary = lesson.platformSummary || {};
    const chapters = (summary.chapters || [])
      .map(item => `[${item.start}] ${item.title}：${item.content}`).join("\n");
    const captions = (lesson.captions || [])
      .map(item => `[${item.start}] ${item.text}`).join("\n");
    return `【第${index + 1}段 ${lesson.time}】\n平台概要：${summary.overview || "无"}\n章节：\n${chapters}\n字幕：\n${captions}`;
  }).join("\n\n");
  return sections.slice(0, 120000);
}

const CONTINUE_PROMPT = "请从上一条内容的中断处继续输出，不要重复已经输出的内容，也不要补充解释。";

async function completeWithAI(prompt, apiKey, provider, model, options = {}) {
  const maxTokens = options.maxTokens || 5000;
  const maxRounds = Math.max(1, options.maxRounds || 1);
  if (provider === "deepseek" || provider === "openai") {
    const base = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";
    const messages = [{role: "user", content: prompt}];
    const chunks = [];
    for (let round = 0; round < maxRounds; round++) {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`},
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens
        })
      });
      const data = await response.json().catch(error => {
        reportCaughtError(`${PROVIDERS[provider].label} 响应 JSON 解析失败`, error);
        return {};
      });
      if (!response.ok) throw new Error(data.error?.message || `${PROVIDERS[provider].label} 请求失败（${response.status}）`);
      const choice = data.choices?.[0] || {};
      const text = choice.message?.content || "";
      if (text) chunks.push(text);
      if (!["length", "max_tokens"].includes(choice.finish_reason) || round === maxRounds - 1) break;
      messages.push({role: "assistant", content: text});
      messages.push({role: "user", content: CONTINUE_PROMPT});
    }
    return chunks.join("").trim();
  }
  if (provider === "anthropic") {
    const messages = [{role: "user", content: prompt}];
    const chunks = [];
    for (let round = 0; round < maxRounds; round++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.2,
          messages
        })
      });
      const data = await response.json().catch(error => {
        reportCaughtError("Claude 响应 JSON 解析失败", error);
        return {};
      });
      if (!response.ok) throw new Error(data.error?.message || `Claude 请求失败（${response.status}）`);
      const text = (data.content || []).map(item => item.text || "").join("");
      if (text) chunks.push(text);
      if (data.stop_reason !== "max_tokens" || round === maxRounds - 1) break;
      messages.push({role: "assistant", content: text});
      messages.push({role: "user", content: CONTINUE_PROMPT});
    }
    return chunks.join("").trim();
  }
  if (provider === "gemini") {
    const contents = [{role: "user", parts: [{text: prompt}]}];
    const chunks = [];
    for (let round = 0; round < maxRounds; round++) {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          contents,
          generationConfig: {temperature: 0.2, maxOutputTokens: maxTokens}
        })
      });
      const data = await response.json().catch(error => {
        reportCaughtError("Gemini 响应 JSON 解析失败", error);
        return {};
      });
      if (!response.ok) throw new Error(data.error?.message || `Gemini 请求失败（${response.status}）`);
      const candidate = data.candidates?.[0] || {};
      const text = (candidate.content?.parts || []).map(item => item.text || "").join("");
      if (text) chunks.push(text);
      if (candidate.finishReason !== "MAX_TOKENS" || round === maxRounds - 1) break;
      contents.push({role: "model", parts: [{text}]});
      contents.push({role: "user", parts: [{text: CONTINUE_PROMPT}]});
    }
    return chunks.join("").trim();
  }
  throw new Error("未知 AI 供应商。");
}

function currentTemplate() {
  return PROMPT_TEMPLATES[$("#prompt-template").value] || PROMPT_TEMPLATES.notes;
}

function setSaveResult(message, isError = false) {
  $("#save-result").textContent = message;
  $("#save-result").classList.toggle("error", isError);
}

async function aiNotesDay(day, lessons, apiKey, provider, model, extraPrompt, template) {
  const prompt = `${template.prompt}

标题请写为：“${currentCourseName("课堂")} · ${day} 课堂笔记”。

${extraPrompt ? `用户追加要求：\n${extraPrompt}\n\n` : ""}课堂材料：
${aiSource(lessons)}`;
  return completeWithAI(prompt, apiKey, provider, model, {
    maxTokens: template.maxOutputTokens,
    maxRounds: template.continuationRounds
  });
}

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = Array.from({length: 256}, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return {time, day};
}

function u16(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function fileBytes(file, encoder) {
  if (file.bytes instanceof Uint8Array) return file.bytes;
  if (file.bytes instanceof ArrayBuffer) return new Uint8Array(file.bytes);
  return encoder.encode(file.text || "");
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function uniquifyZipName(name, usedNames) {
  const clean = name || "未命名";
  if (!usedNames.has(clean)) {
    usedNames.add(clean);
    return clean;
  }
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let index = 2;
  while (usedNames.has(`${base} (${index})${ext}`)) index++;
  const unique = `${base} (${index})${ext}`;
  usedNames.add(unique);
  return unique;
}

function zipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const {time, day} = dosDateTime();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = fileBytes(file, encoder);
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
    ]);
    const central = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  const central = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(centralStart), u16(0)
  ]);
  return new Blob([concatBytes([...localParts, central, end])], {type: "application/zip"});
}

async function downloadZipNow(filename, files) {
  const blob = zipBlob(files);
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function prepareZipDownload(filename, files) {
  if (state.pendingDownload?.url) URL.revokeObjectURL(state.pendingDownload.url);
  const blob = zipBlob(files);
  state.pendingDownload = {url: URL.createObjectURL(blob), filename};
  $("#download-zip").classList.remove("hidden");
}

async function downloadPreparedZip() {
  if (!state.pendingDownload) return;
  const {url, filename} = state.pendingDownload;
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } finally {
    state.pendingDownload = null;
    $("#download-zip").classList.add("hidden");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function collect(replays, options = {}) {
  const lessons = [];
  const failures = [];
  for (let i = 0; i < replays.length; i++) {
    const replay = replays[i];
    if (!options.silent) {
      progress(i, replays.length, `读取 ${replay.time}`);
      log(`读取 ${replay.time}…`);
    }
    try {
      const reply = await send({action: "extractCaptions", time: replay.time});
      if (reply?.error) throw new Error(reply.error);
      if (!reply?.captions?.length && !reply?.platformSummary?.overview) {
        throw new Error("没有字幕或概要");
      }
      lessons.push(reply);
    } catch (error) {
      failures.push(`${replay.time}：${error.message}`);
      reportCaughtError(`跳过 ${replay.time}`, error, {ui: !options.silent});
    }
    if (!options.silent) progress(i + 1, replays.length, `已读取 ${i + 1} / ${replays.length}`);
  }
  return {lessons, failures};
}

async function testAIConnection({quiet = false} = {}) {
  const {id, label} = currentProvider();
  const apiKey = $("#api-key").value.trim();
  const model = $("#model").value.trim();
  if (!apiKey) throw new Error("请先填写 API Key。");
  if (!model) throw new Error("请先填写模型名。");
  if (!quiet) $("#speed-result").textContent = "测速中…";
  const started = performance.now();
  const text = await completeWithAI("请只回复：ok", apiKey, id, model);
  const elapsed = Math.round(performance.now() - started);
  const result = `${label} / ${model} 可用，${elapsed} ms`;
  $("#speed-result").textContent = result;
  if (!quiet) log(`测速成功：${result}`);
  return {elapsed, text};
}

async function run(days) {
  if (state.running) return;
  const useAI = $("#use-ai").checked;
  const {id: provider, label: providerLabel} = currentProvider();
  const apiKey = $("#api-key").value.trim();
  const model = $("#model").value.trim();
  const extraPrompt = $("#custom-prompt").value.trim();
  const template = currentTemplate();
  if (!days.size) {
    log("请至少勾选一个日期。");
    return;
  }
  if (useAI && !apiKey) {
    $("#api-key").focus();
    log("请先填写并保存 API Key。");
    return;
  }
  if (useAI && !model) {
    $("#model").focus();
    log("请先填写模型名。");
    return;
  }
  setRunning(true);
  $("#download-zip").classList.add("hidden");
  if (state.pendingDownload?.url) URL.revokeObjectURL(state.pendingDownload.url);
  state.pendingDownload = null;
  $("#log").textContent = "开始处理。请保持自动打开的课堂视频页打开，不要刷新或手动切换回放。";
  try {
    if (useAI) await testAIConnection({quiet: true});
    state.tab = await courseTab();
    const selected = state.replays.filter(item => days.has(item.time.slice(0, 10)));
    const {lessons, failures} = await collect(selected);
    const grouped = groupReplays(lessons);
    const folder = safeName(currentCourseName("SJTU课堂概要"));
    const files = [];
    const index = [`# ${currentCourseName("课堂")} · 导出索引`, "", `共导出 ${grouped.size} 个上课日、${lessons.length} 段回放。`, ""];
    if (useAI) index.push(`AI：${providerLabel} / ${model}`, "");

    let dayIndex = 0;
    for (const day of [...grouped.keys()].sort()) {
      const dayLessons = grouped.get(day);
      progress(dayIndex, grouped.size, `整理 ${day}`);
      files.push({name: `原字幕/${day}-原字幕.md`, text: captionsMarkdown(day, dayLessons)});
      if (useAI) {
        log(`${providerLabel} 正在整理 ${day}…`);
        const notes = await aiNotesDay(day, dayLessons, apiKey, provider, model, extraPrompt, template);
        files.push({name: `AI整理/${day}-${template.label}.${template.extension}`, text: notes});
      }
      index.push(`- ${day}：${dayLessons.length} 段回放`);
      dayIndex++;
      progress(dayIndex, grouped.size, `已整理 ${day}`);
    }
    if (failures.length) {
      index.push("", "## 未成功读取", "", ...failures.map(item => `- ${item}`));
    }
    files.unshift({name: "导出索引.md", text: index.join("\n")});
    prepareZipDownload(`${folder}-${timestampName()}.zip`, files);
    progress(grouped.size, grouped.size, "全部完成");
    log(`完成：已生成 ZIP，包含 ${grouped.size} 个日期、${files.length} 个文件。点击下载按钮保存。`);
    if (failures.length) log(`另有 ${failures.length} 段未成功，详见导出索引。`);
  } catch (error) {
    progress(0, 0, "处理失败");
    reportCaughtError("课堂视频概要导出失败", error, {ui: true});
  } finally {
    setRunning(false);
  }
}

$("#refresh").addEventListener("click", loadCourse);
$("#course-pages").addEventListener("change", async () => {
  if (!$("#course-pages").value) return;
  state.selectedPageKey = $("#course-pages").value;
  state.tab = null;
  state.replays = [];
  state.files = [];
  state.selectedFileIds.clear();
  $("#file-search").value = "";
  renderFiles();
  await loadCourse();
});
$("#settings-toggle").addEventListener("click", () => {
  $("#settings-backdrop").classList.remove("hidden");
});
$("#settings-close").addEventListener("click", () => {
  $("#settings-backdrop").classList.add("hidden");
});
$("#settings-backdrop").addEventListener("click", event => {
  if (event.target.id === "settings-backdrop") $("#settings-backdrop").classList.add("hidden");
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") $("#settings-backdrop").classList.add("hidden");
});
$("#use-ai").addEventListener("change", () => {
  $("#prompt-row").classList.toggle("hidden", !$("#use-ai").checked);
  $("#key-row").classList.toggle("hidden", !$("#use-ai").checked);
});
$("#provider").addEventListener("change", async () => {
  const {id} = currentProvider();
  await chrome.storage.local.set({aiProvider: id});
  await loadProviderSettings();
  setSaveResult("");
});
$("#model").addEventListener("change", async () => {
  const {id} = currentProvider();
  const saved = await chrome.storage.local.get("aiModels");
  await chrome.storage.local.set({aiModels: {...(saved.aiModels || {}), [id]: $("#model").value.trim()}});
  setSaveResult("");
});
$("#save-key").addEventListener("click", async () => {
  const key = $("#api-key").value.trim();
  const {id, label, storageKey} = currentProvider();
  const model = $("#model").value.trim();
  if (!key) {
    setSaveResult("API Key 为空，未保存", true);
    return log("API Key 为空，未保存。");
  }
  setSaveResult("保存中…");
  const saved = await chrome.storage.local.get(["aiKeys", "aiModels"]);
  await chrome.storage.local.set({
    aiProvider: id,
    aiKeys: {...(saved.aiKeys || {}), [id]: key},
    aiModels: {...(saved.aiModels || {}), [id]: model},
    [storageKey]: key,
    [`${storageKey}SavedAt`]: new Date().toISOString()
  });
  setSaveResult("保存成功");
  log(`${label} API Key 已保存。`);
});
$("#test-ai").addEventListener("click", async () => {
  try {
    $("#test-ai").disabled = true;
    setSaveResult("");
    await testAIConnection();
  } catch (error) {
    $("#speed-result").textContent = `测速失败：${error.message}`;
    reportCaughtError("测速失败", error, {ui: true});
  } finally {
    $("#test-ai").disabled = false;
  }
});
$("#export-selected").addEventListener("click", () => run(selectedDays()));
$("#download-zip").addEventListener("click", downloadPreparedZip);
$("#refresh-files").addEventListener("click", () => loadFiles());
$("#refresh-video").addEventListener("click", () => loadVideo());
$("#download-files").addEventListener("click", downloadSelectedFiles);
$("#file-search").addEventListener("input", renderFiles);
$("#select-all-files").addEventListener("click", () => {
  filteredFiles().forEach(file => state.selectedFileIds.add(file.id));
  renderFiles();
});
$("#clear-files").addEventListener("click", () => {
  filteredFiles().forEach(file => state.selectedFileIds.delete(file.id));
  renderFiles();
});
$("#select-all-days").addEventListener("click", () => {
  document.querySelectorAll(".day-check").forEach(input => input.checked = true);
});
$("#clear-days").addEventListener("click", () => {
  document.querySelectorAll(".day-check").forEach(input => input.checked = false);
});
$("#custom-prompt").addEventListener("input", () => {
  chrome.storage.local.set({customPrompt: $("#custom-prompt").value});
});
$("#prompt-template").addEventListener("change", () => {
  chrome.storage.local.set({promptTemplate: $("#prompt-template").value});
});

async function loadProviderSettings() {
  const {id, defaultModel, keyPlaceholder, storageKey} = currentProvider();
  const saved = await chrome.storage.local.get(["aiKeys", "aiModels", storageKey, `${storageKey}SavedAt`]);
  const key = saved.aiKeys?.[id] || saved[storageKey] || "";
  const model = saved.aiModels?.[id] || defaultModel;
  $("#api-key").value = key;
  $("#api-key").placeholder = keyPlaceholder;
  $("#model").value = model;
  $("#speed-result").textContent = "尚未测速";
  setSaveResult("");
}

chrome.storage.local.get(["aiProvider", "customPrompt", "promptTemplate"]).then(async ({aiProvider, customPrompt, promptTemplate}) => {
  if (aiProvider && PROVIDERS[aiProvider]) $("#provider").value = aiProvider;
  if (promptTemplate && PROMPT_TEMPLATES[promptTemplate]) $("#prompt-template").value = promptTemplate;
  if (customPrompt) $("#custom-prompt").value = customPrompt;
  await loadProviderSettings();
});
loadCourse();

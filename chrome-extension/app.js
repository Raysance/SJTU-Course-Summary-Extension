const $ = selector => document.querySelector(selector);
const state = {
  tab: null,
  coursePages: [],
  selectedTabId: null,
  replays: [],
  metadata: {},
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

const PROMPT_TEMPLATES = {
  notes: {
    label: "课堂笔记",
    extension: "md",
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

function setRunning(running) {
  state.running = running;
  $("#export-selected").disabled = running || !state.replays.length;
  $("#refresh").disabled = running;
  $("#select-all-days").disabled = running || !state.replays.length;
  $("#clear-days").disabled = running || !state.replays.length;
  document.querySelectorAll(".day-check").forEach(input => input.disabled = running);
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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function timestampName() {
  const date = new Date();
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

async function courseTab() {
  if (state.selectedTabId) return {id: state.selectedTabId};
  await discoverCoursePages();
  if (!state.selectedTabId) throw new Error("未找到课堂视频页，请先在 Chrome 中打开并登录课程。");
  return {id: state.selectedTabId};
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) throw error;
    await chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]});
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function send(message) {
  return sendToTab(state.tab.id, message);
}

async function discoverCoursePages() {
  const tabs = await chrome.tabs.query({url: "https://v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/*"});
  const sorted = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const pages = [];
  for (const tab of sorted) {
    try {
      const reply = await sendToTab(tab.id, {action: "listReplays"});
      if (reply?.replays?.length) pages.push({tab, replays: reply.replays, metadata: reply.metadata || {}});
    } catch (_) {
      pages.push({tab, replays: [], metadata: {course: tab.title || "课堂视频"}});
    }
  }
  state.coursePages = pages;
  if (!pages.length) {
    state.selectedTabId = null;
    return;
  }
  if (!pages.some(page => page.tab.id === state.selectedTabId)) state.selectedTabId = pages[0].tab.id;
}

function renderCoursePages() {
  const select = $("#course-pages");
  select.textContent = "";
  state.coursePages.forEach((page, index) => {
    const option = document.createElement("option");
    option.value = String(page.tab.id);
    const course = page.metadata.course || page.tab.title || `课堂页面 ${index + 1}`;
    const teacher = page.metadata.teacher ? ` · ${page.metadata.teacher}` : "";
    const count = page.replays?.length ? ` · ${page.replays.length} 回放` : "";
    option.textContent = `${course}${teacher}${count}`;
    select.append(option);
  });
  select.value = String(state.selectedTabId || "");
  select.classList.toggle("hidden", state.coursePages.length <= 1);
}

async function loadCourse() {
  if (state.running) return;
  $("#log").textContent = "正在读取课程页面…";
  try {
    await discoverCoursePages();
    renderCoursePages();
    const page = state.coursePages.find(item => item.tab.id === state.selectedTabId);
    if (!page) throw new Error("未找到课堂视频页，请先在 Chrome 中打开并登录课程。");
    if (!page.replays?.length) throw new Error("页面尚未加载出回放列表，请刷新课程页后重试。");
    state.tab = page.tab;
    state.replays = page.replays;
    state.metadata = page.metadata || {};
    state.previewCache.clear();
    const grouped = groupReplays(state.replays);
    $("#course").textContent = state.metadata.course || "SJTU 课堂视频";
    $("#meta").textContent = `${state.metadata.teacher || "教师信息未显示"} · ${state.replays.length} 个回放 · ${grouped.size} 个上课日`;
    renderDayChecks(grouped);
    $("#export-selected").disabled = false;
    $("#select-all-days").disabled = false;
    $("#clear-days").disabled = false;
    progress(0, state.replays.length, "准备就绪");
    $("#log").textContent = "课程读取成功。可勾选一个或多个日期，也可以全选。";
  } catch (error) {
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

function selectedDays() {
  return new Set([...document.querySelectorAll(".day-check:checked")].map(input => input.value));
}

function captionsMarkdown(day, lessons) {
  const lines = [
    `# ${state.metadata.course || "课堂"} · ${day} 原字幕`,
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

async function completeWithAI(prompt, apiKey, provider, model) {
  if (provider === "deepseek" || provider === "openai") {
    const base = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`},
      body: JSON.stringify({
        model,
        messages: [{role: "user", content: prompt}],
        temperature: 0.2,
        max_tokens: 5000
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `${PROVIDERS[provider].label} 请求失败（${response.status}）`);
    return data.choices?.[0]?.message?.content?.trim() || "";
  }
  if (provider === "anthropic") {
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
        max_tokens: 5000,
        temperature: 0.2,
        messages: [{role: "user", content: prompt}]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `Claude 请求失败（${response.status}）`);
    return (data.content || []).map(item => item.text || "").join("").trim();
  }
  if (provider === "gemini") {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        contents: [{parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.2, maxOutputTokens: 5000}
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `Gemini 请求失败（${response.status}）`);
    return (data.candidates?.[0]?.content?.parts || []).map(item => item.text || "").join("").trim();
  }
  throw new Error("未知 AI 供应商。");
}

function currentTemplate() {
  return PROMPT_TEMPLATES[$("#prompt-template").value] || PROMPT_TEMPLATES.notes;
}

async function aiNotesDay(day, lessons, apiKey, provider, model, extraPrompt, template) {
  const prompt = `${template.prompt}

标题请写为：“${state.metadata.course || "课堂"} · ${day} 课堂笔记”。

${extraPrompt ? `用户追加要求：\n${extraPrompt}\n\n` : ""}课堂材料：
${aiSource(lessons)}`;
  return completeWithAI(prompt, apiKey, provider, model);
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

function zipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const {time, day} = dosDateTime();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
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
      if (!options.silent) log(`跳过 ${replay.time}：${error.message}`);
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
  $("#log").textContent = "开始处理。请保持课程页面打开，不要刷新或手动切换回放。";
  try {
    if (useAI) await testAIConnection({quiet: true});
    state.tab = await courseTab();
    const selected = state.replays.filter(item => days.has(item.time.slice(0, 10)));
    const {lessons, failures} = await collect(selected);
    const grouped = groupReplays(lessons);
    const folder = safeName(state.metadata.course || "SJTU课堂概要");
    const files = [];
    const index = [`# ${state.metadata.course || "课堂"} · 导出索引`, "", `共导出 ${grouped.size} 个上课日、${lessons.length} 段回放。`, ""];
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
    log(`失败：${error.message}`);
  } finally {
    setRunning(false);
  }
}

$("#refresh").addEventListener("click", loadCourse);
$("#course-pages").addEventListener("change", async () => {
  state.selectedTabId = Number($("#course-pages").value);
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
});
$("#model").addEventListener("change", async () => {
  const {id} = currentProvider();
  const saved = await chrome.storage.local.get("aiModels");
  await chrome.storage.local.set({aiModels: {...(saved.aiModels || {}), [id]: $("#model").value.trim()}});
});
$("#save-key").addEventListener("click", async () => {
  const key = $("#api-key").value.trim();
  const {id, label, storageKey} = currentProvider();
  const model = $("#model").value.trim();
  if (!key) return log("API Key 为空，未保存。");
  const saved = await chrome.storage.local.get(["aiKeys", "aiModels"]);
  await chrome.storage.local.set({
    aiProvider: id,
    aiKeys: {...(saved.aiKeys || {}), [id]: key},
    aiModels: {...(saved.aiModels || {}), [id]: model},
    [storageKey]: key,
    [`${storageKey}SavedAt`]: new Date().toISOString()
  });
  log(`${label} API Key 已保存。`);
});
$("#test-ai").addEventListener("click", async () => {
  try {
    $("#test-ai").disabled = true;
    await testAIConnection();
  } catch (error) {
    $("#speed-result").textContent = `测速失败：${error.message}`;
    log(`测速失败：${error.message}`);
  } finally {
    $("#test-ai").disabled = false;
  }
});
$("#export-selected").addEventListener("click", () => run(selectedDays()));
$("#download-zip").addEventListener("click", downloadPreparedZip);
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
}

chrome.storage.local.get(["aiProvider", "customPrompt", "promptTemplate"]).then(async ({aiProvider, customPrompt, promptTemplate}) => {
  if (aiProvider && PROVIDERS[aiProvider]) $("#provider").value = aiProvider;
  if (promptTemplate && PROMPT_TEMPLATES[promptTemplate]) $("#prompt-template").value = promptTemplate;
  if (customPrompt) $("#custom-prompt").value = customPrompt;
  await loadProviderSettings();
});
loadCourse();

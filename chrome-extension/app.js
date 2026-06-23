const $ = selector => document.querySelector(selector);
const state = {
  tab: null,
  replays: [],
  metadata: {},
  running: false,
  previewCache: new Map(),
  previewShowTimer: null,
  previewHideTimer: null
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

const DEFAULT_PROMPT = `你是课堂笔记整理助手。请根据课堂概要、章节导航和字幕，整理一份适合复习与回顾的中文 Markdown 课堂笔记。

要求：
1. 使用“总 / 分”的结构呈现。
2. “总”部分概括本次课的主题、主线、核心结论和学习重点。
3. “分”部分按知识模块整理，每个模块包含关键概念、老师强调点、逻辑关系、例子或易混点。
4. 不需要输出原字幕，不要逐句转写。
5. 不需要强调页码整理；只有材料中明确出现页码时才可自然提及。
6. 表达简明、层次清楚，适合直接作为课堂笔记保存。
7. 只依据提供的课堂材料整理，不补充材料外的信息。`;

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
  const tabs = await chrome.tabs.query({url: "https://v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/*"});
  if (!tabs.length) throw new Error("未找到课堂视频页，请先在 Chrome 中打开并登录课程。");
  return [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function send(message) {
  try {
    return await chrome.tabs.sendMessage(state.tab.id, message);
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) throw error;
    await chrome.scripting.executeScript({target: {tabId: state.tab.id}, files: ["content.js"]});
    return chrome.tabs.sendMessage(state.tab.id, message);
  }
}

async function loadCourse() {
  if (state.running) return;
  $("#log").textContent = "正在读取课程页面…";
  try {
    state.tab = await courseTab();
    const reply = await send({action: "listReplays"});
    if (!reply?.replays?.length) throw new Error("页面尚未加载出回放列表，请刷新课程页后重试。");
    state.replays = reply.replays;
    state.metadata = reply.metadata || {};
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

async function aiNotesDay(day, lessons, apiKey, provider, model, extraPrompt) {
  const prompt = `${DEFAULT_PROMPT}

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

async function downloadZip(filename, files) {
  const blob = zipBlob(files);
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({url, filename, conflictAction: "uniquify", saveAs: false});
  } finally {
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
        const notes = await aiNotesDay(day, dayLessons, apiKey, provider, model, extraPrompt);
        files.push({name: `AI整理/${day}-课堂笔记.md`, text: notes});
      }
      index.push(`- ${day}：${dayLessons.length} 段回放`);
      dayIndex++;
      progress(dayIndex, grouped.size, `已整理 ${day}`);
    }
    if (failures.length) {
      index.push("", "## 未成功读取", "", ...failures.map(item => `- ${item}`));
    }
    files.unshift({name: "导出索引.md", text: index.join("\n")});
    await downloadZip(`${folder}-${timestampName()}.zip`, files);
    progress(grouped.size, grouped.size, "全部完成");
    log(`完成：已打包 ZIP，包含 ${grouped.size} 个日期、${files.length} 个文件。`);
    if (failures.length) log(`另有 ${failures.length} 段未成功，详见导出索引。`);
  } catch (error) {
    progress(0, 0, "处理失败");
    log(`失败：${error.message}`);
  } finally {
    setRunning(false);
  }
}

$("#refresh").addEventListener("click", loadCourse);
$("#settings-toggle").addEventListener("click", () => {
  $("#settings-panel").classList.toggle("hidden");
});
$("#use-ai").addEventListener("change", () => {
  $("#prompt-row").classList.toggle("hidden", !$("#use-ai").checked);
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
$("#select-all-days").addEventListener("click", () => {
  document.querySelectorAll(".day-check").forEach(input => input.checked = true);
});
$("#clear-days").addEventListener("click", () => {
  document.querySelectorAll(".day-check").forEach(input => input.checked = false);
});
$("#custom-prompt").addEventListener("input", () => {
  chrome.storage.local.set({customPrompt: $("#custom-prompt").value});
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

chrome.storage.local.get(["aiProvider", "customPrompt"]).then(async ({aiProvider, customPrompt}) => {
  if (aiProvider && PROVIDERS[aiProvider]) $("#provider").value = aiProvider;
  if (customPrompt) $("#custom-prompt").value = customPrompt;
  await loadProviderSettings();
});
loadCourse();

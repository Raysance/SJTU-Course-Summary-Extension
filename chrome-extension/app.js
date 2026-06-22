const $ = selector => document.querySelector(selector);
const state = {tab: null, replays: [], metadata: {}, running: false};

function log(message) {
  const now = new Date().toLocaleTimeString("zh-CN", {hour12: false});
  $("#log").textContent += `\n[${now}] ${message}`;
  $("#log").scrollTop = $("#log").scrollHeight;
}

function setRunning(running) {
  state.running = running;
  $("#export-selected").disabled = running || !state.replays.length;
  $("#refresh").disabled = running;
  $("#scope").disabled = running || !state.replays.length;
}

function progress(done, total, title) {
  $("#progress-title").textContent = title;
  $("#progress-count").textContent = `${done} / ${total}`;
  $("#bar").style.width = total ? `${Math.round(done * 100 / total)}%` : "0";
}

function safeName(value) {
  return (value || "课堂概要").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
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
    $("#scope").innerHTML = [
      `<option value="all">全选：导出所有日期（${state.replays.length} 段）</option>`,
      ...[...grouped.keys()].sort().reverse()
        .map(day => `<option value="${day}">${day}（${grouped.get(day).length} 段）</option>`)
    ].join("");
    $("#scope").disabled = false;
    $("#export-selected").disabled = false;
    progress(0, state.replays.length, "准备就绪");
    $("#log").textContent = "课程读取成功。可在“导出范围”中选择全选或某一天。";
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

function rawDayMarkdown(day, lessons) {
  const lines = [
    `# ${state.metadata.course || "课堂"} · ${day}`,
    "",
    `> 教师：${state.metadata.teacher || "未显示"}  `,
    `> 当日回放：${lessons.length} 段  `,
    "> 来源：SJTU 视频平台 AI 字幕、概要和章节导航",
    ""
  ];
  lessons.forEach((lesson, index) => {
    lines.push(`## 第 ${index + 1} 段 · ${lesson.time.slice(11, 16)}`, "");
    const summary = lesson.platformSummary || {};
    if (summary.overview) lines.push("### 平台概要", "", summary.overview, "");
    if (summary.chapters?.length) {
      lines.push("### 章节导航", "");
      summary.chapters.forEach(item => {
        lines.push(`- **${item.start || ""} ${item.title || ""}**：${item.content || ""}`);
      });
      lines.push("");
    }
    if (lesson.captions?.length) {
      lines.push("<details>", "<summary>展开平台字幕</summary>", "");
      lesson.captions.forEach(item => lines.push(`- \`${item.start}\` ${item.text}`));
      lines.push("", "</details>", "");
    }
  });
  return lines.join("\n");
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

async function deepSeekDay(day, lessons, apiKey) {
  const prompt = `你是考试笔记整理助手。以下是同一天的多段课堂平台概要、章节导航和字幕。这节课以教师带学生在教材上划考试笔记为主。

请生成简明、准确的中文 Markdown，要求：
1. 同一天所有回放合并整理，去重，不按视频机械重复。
2. 按“考试安排与答题”“分章考点”“易错陷阱”“考前最小清单”组织。
3. 每个考点必须写成“页码｜批注｜要点”。页码不确定时明确写“页码待核对”，严禁编造。
4. 批注要短，适合直接写在教材边栏；要点突出关键词、判断关系和答题表述。
5. 只依据提供内容，不补充课堂未出现的信息。
6. 开头标题写“${state.metadata.course || "课堂"} · ${day} 考试要点”。

课堂材料：
${aiSource(lessons)}`;
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`},
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{role: "user", content: prompt}],
      temperature: 0.2,
      max_tokens: 5000
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `DeepSeek 请求失败（${response.status}）`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function downloadText(filename, text) {
  const blob = new Blob([text], {type: "text/markdown;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({url, filename, conflictAction: "uniquify", saveAs: false});
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function collect(replays) {
  const lessons = [];
  const failures = [];
  for (let i = 0; i < replays.length; i++) {
    const replay = replays[i];
    progress(i, replays.length, `读取 ${replay.time}`);
    log(`读取 ${replay.time}…`);
    try {
      const reply = await send({action: "extractCaptions", time: replay.time});
      if (reply?.error) throw new Error(reply.error);
      if (!reply?.captions?.length && !reply?.platformSummary?.overview) {
        throw new Error("没有字幕或概要");
      }
      lessons.push(reply);
    } catch (error) {
      failures.push(`${replay.time}：${error.message}`);
      log(`跳过 ${replay.time}：${error.message}`);
    }
    progress(i + 1, replays.length, `已读取 ${i + 1} / ${replays.length}`);
  }
  return {lessons, failures};
}

async function run(days) {
  if (state.running) return;
  const useAI = $("#use-ai").checked;
  const apiKey = $("#api-key").value.trim();
  if (useAI && !apiKey) {
    $("#api-key").focus();
    log("请先填写并保存 DeepSeek API Key。");
    return;
  }
  setRunning(true);
  $("#log").textContent = "开始处理。请保持课程页面打开，不要刷新或手动切换回放。";
  try {
    state.tab = await courseTab();
    const selected = state.replays.filter(item => days.has(item.time.slice(0, 10)));
    const {lessons, failures} = await collect(selected);
    const grouped = groupReplays(lessons);
    const folder = safeName(state.metadata.course || "SJTU课堂概要");
    const index = [`# ${state.metadata.course || "课堂"} · 课程概要索引`, "", `共导出 ${grouped.size} 个上课日、${lessons.length} 段回放。`, ""];

    let dayIndex = 0;
    for (const day of [...grouped.keys()].sort()) {
      const dayLessons = grouped.get(day);
      progress(dayIndex, grouped.size, `整理 ${day}`);
      let markdown = rawDayMarkdown(day, dayLessons);
      if (useAI) {
        log(`DeepSeek 正在总结 ${day}…`);
        const summary = await deepSeekDay(day, dayLessons, apiKey);
        markdown = `${summary}\n\n---\n\n${markdown}`;
      }
      const name = `${folder}/${day}-${useAI ? "考试要点与课堂概要" : "课堂概要"}.md`;
      await downloadText(name, markdown);
      index.push(`- ${day}：${dayLessons.length} 段回放`);
      dayIndex++;
      progress(dayIndex, grouped.size, `已导出 ${day}`);
    }
    if (failures.length) {
      index.push("", "## 未成功读取", "", ...failures.map(item => `- ${item}`));
    }
    await downloadText(`${folder}/课程概要索引.md`, index.join("\n"));
    progress(grouped.size, grouped.size, "全部完成");
    log(`完成：导出 ${grouped.size} 个日期，成功读取 ${lessons.length} 段。`);
    if (failures.length) log(`另有 ${failures.length} 段未成功，详见课程概要索引。`);
  } catch (error) {
    progress(0, 0, "处理失败");
    log(`失败：${error.message}`);
  } finally {
    setRunning(false);
  }
}

$("#refresh").addEventListener("click", loadCourse);
$("#use-ai").addEventListener("change", () => $("#key-row").classList.toggle("hidden", !$("#use-ai").checked));
$("#save-key").addEventListener("click", async () => {
  const key = $("#api-key").value.trim();
  if (!key) return log("API Key 为空，未保存。");
  await chrome.storage.local.set({deepseekApiKey: key, deepseekApiKeySavedAt: new Date().toISOString()});
  $("#key-note").textContent = "已长期保存到本机 Chrome 扩展存储。更新扩展不会清除，卸载扩展会删除。";
  log("DeepSeek API Key 已长期保存。");
});
$("#export-selected").addEventListener("click", () => {
  const value = $("#scope").value;
  const days = value === "all"
    ? new Set(state.replays.map(item => item.time.slice(0, 10)))
    : new Set([value]);
  run(days);
});

chrome.storage.local.get(["deepseekApiKey", "deepseekApiKeySavedAt"]).then(({deepseekApiKey, deepseekApiKeySavedAt}) => {
  if (deepseekApiKey) {
    $("#api-key").value = deepseekApiKey;
    const saved = deepseekApiKeySavedAt ? new Date(deepseekApiKeySavedAt).toLocaleString("zh-CN", {hour12: false}) : "此前";
    $("#key-note").textContent = `已读取长期保存的 API Key（保存时间：${saved}）。`;
  }
});
loadCourse();

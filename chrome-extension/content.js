(() => {
  if (globalThis.__SJTU_CAPTION_TOOL_LOADED__) return;
  globalThis.__SJTU_CAPTION_TOOL_LOADED__ = true;

  // Selectors verified in the modern play-center's CourseList, VideoPlay,
  // AiCaption and Summarize components (990.20fdca61.js).
  function videoRoot() {
    return document.querySelector(".video-page-wrapper") || document;
  }

  function sourceKey() {
    const value = location.href + "|" + courseName();
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(36);
  }

  function courseName() {
    return document.querySelector("header .tecl-info .top")?.textContent.trim() || document.title;
  }

  function pageMetadata() {
    const header = document.querySelector("header .tecl-info");
    return {
      pageTitle: document.title,
      course: courseName(),
      teacher: header?.querySelector(".bottom > .sle")?.textContent.trim() || "",
      platform: SJTUVideo.isModernUrl(location.href) ? "resourcemanage" : "unsupported",
      sourceKey: sourceKey()
    };
  }

  function replayRows() {
    const cards = [...videoRoot().querySelectorAll(".course-list-wrapper .list-wrap .list-item")];
    return cards.map((card, index) => {
      if (card.classList.contains("can-not-play") || card.classList.contains("disabled")) return null;
      const label = card.textContent.replace(/\s+/g, " ").trim();
      const text = [label, ...[...card.querySelectorAll("[title]")].map(node => node.getAttribute("title"))].join(" ");
      const match = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
      if (!match) return null;
      const [, year, month, day, hour, minute, second] = match;
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null;
      if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59)) return null;
      const pad = value => value.padStart(2, "0");
      const time = `${year}-${pad(month)}-${pad(day)}${hour === undefined ? "" : ` ${pad(hour)}:${minute}:${second || "00"}`}`;
      if (!card.id) card.id = `sjtu-replay-${index}`;
      return {index, time, label, id: card.id};
    }).filter(Boolean);
  }

  function capture() {
    const root = videoRoot();
    const captions = [...root.querySelectorAll(".ai-caption-wrapper .caption-card")].map(card => ({
      start: card.querySelector(".time-wrapper .time")?.textContent.trim() || "",
      text: [...card.querySelectorAll(".caption-text")].map(node => node.textContent).join("").replace(/\s+/g, " ").trim()
    })).filter(item => item.start && item.text);
    const outline = root.querySelector(".outline-wrapper");
    const overview = outline?.querySelector(".summary-content")?.textContent.trim() || "";
    const chapters = [...(outline?.querySelectorAll(".chapter-navigation .skim-wrapper") || [])].map(node => ({
      start: node.querySelector(".skim-time .time")?.textContent.trim() || "",
      title: node.querySelector(".skim-title")?.textContent.trim() || "",
      content: node.querySelector(".skim-content")?.textContent.trim() || ""
    })).filter(item => item.title || item.content);
    return {captions, platformSummary: {overview, chapters}};
  }

  function waitForSelectedReplay(selected, context, sendResponse) {
    const now = Date.now();
    if (courseName() !== context.course) return sendResponse({error: "视频页已切换课程，请重新读取。"});
    const card = document.getElementById(selected.id);
    const data = capture();
    const signature = JSON.stringify(data);
    const hasContent = data.captions.length || data.platformSummary.overview || data.platformSummary.chapters.length;
    if (card?.classList.contains("selected") && hasContent && (context.alreadySelected || signature !== context.previous)) {
      if (signature !== context.lastSignature) {
        context.lastSignature = signature;
        context.stableSince = now;
      } else if (now - context.stableSince >= 750) {
        const metadata = pageMetadata();
        sendResponse({schemaVersion: 4, source: "v.sjtu.edu.cn-resourcemanage-platform-captions", time: selected.time,
          course: metadata.course, teacher: metadata.teacher, sourceKey: metadata.sourceKey,
          replayLabel: selected.label, ...data, capturedAt: new Date().toISOString()});
        return;
      }
    } else {
      context.lastSignature = "";
    }
    if (now >= context.deadline) {
      sendResponse({error: hasContent ? "字幕尚未切换到所选节次，请重新读取。" : "所选节次暂未生成字幕或概要。"});
      return;
    }
    setTimeout(() => waitForSelectedReplay(selected, context, sendResponse), 250);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["listReplays", "extractCaptions"].includes(message?.action)) return false;
    if (!SJTUVideo.isModernUrl(location.href)) {
      sendResponse({error: "请从新版课堂视频读取。"});
      return false;
    }
    const replays = replayRows();
    if (message.action === "listReplays") {
      sendResponse({replays, metadata: pageMetadata()});
      return false;
    }
    if (message.sourceKey && message.sourceKey !== sourceKey()) {
      sendResponse({error: "视频页已切换，请重新读取课程。"});
      return false;
    }
    const matches = replays.filter(item => item.time === message.time && (!message.id || item.id === message.id));
    const selected = matches.length === 1 ? matches[0] : null;
    const card = selected && document.getElementById(selected.id);
    if (!card || message.label && message.label !== selected.label) {
      sendResponse({error: "回放列表已改变，请重新读取。"});
      return false;
    }
    const context = {course: courseName(), previous: JSON.stringify(capture()),
      alreadySelected: card.classList.contains("selected"), lastSignature: "", stableSince: 0, deadline: Date.now() + 30000};
    if (!context.alreadySelected) (card.querySelector(".list-item__right") || card).click();
    waitForSelectedReplay(selected, context, sendResponse);
    return true;
  });
})();

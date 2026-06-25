if (!globalThis.__SJTU_CAPTION_TOOL_LOADED__) {
globalThis.__SJTU_CAPTION_TOOL_LOADED__ = true;

function replayRows() {
  const timestamp = /20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
  return [...document.querySelectorAll(".ivs-video-list .list-item")].map((card, index) => {
    const text = card.textContent.replace(/\s+/g, " ").trim();
    const time = text.match(timestamp)?.[0];
    if (!time) return null;
    return {index, time, label: text, id: card.id || `list-item-${index}`};
  }).filter(Boolean);
}

function captionRows() {
  return [...document.querySelectorAll(".ai-caption-wrapper .caption-card")].map(card => {
    const start = card.querySelector(".time-wrapper")?.textContent.trim() || "";
    const text = [...card.querySelectorAll(".caption-text")]
      .map(node => node.textContent).join("").replace(/\s+/g, " ").trim();
    return {start, text};
  }).filter(item => item.start && item.text);
}

function platformSummary() {
  const overview = document.querySelector(".summary-content")?.textContent.trim() || "";
  const chapters = [...document.querySelectorAll(".chapter-navigation .skim-wrapper")].map(node => ({
    start: node.querySelector(".skim-time")?.textContent.trim() || "",
    title: node.querySelector(".skim-title")?.textContent.trim() || "",
    content: node.querySelector(".skim-content")?.textContent.trim() || ""
  })).filter(item => item.title || item.content);
  return {overview, chapters};
}

function pageMetadata() {
  const header = document.querySelector("header");
  return {
    pageTitle: document.title,
    course: header?.querySelector(".video-info .top")?.textContent.trim() || document.title,
    teacher: header?.querySelector(".video-info .bottom > div:first-child")?.textContent.trim() || ""
  };
}

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(href, base = location.href) {
  try {
    return new URL(href, base).href;
  } catch (_) {
    return "";
  }
}

function canvasCourseId(url) {
  return absoluteUrl(url).match(/\/courses\/(\d+)/)?.[1] || "";
}

function canvasCoursesFromPage() {
  const courses = new Map();
  for (const anchor of document.querySelectorAll("a[href*='/courses/']")) {
    const url = absoluteUrl(anchor.getAttribute("href")).replace(/[#?].*$/, "");
    const id = canvasCourseId(url);
    if (!id || /\/courses\/\d+\//.test(url)) continue;
    const row = anchor.closest("tr");
    const cells = row ? [...row.querySelectorAll("td")].map(cell => cleanText(cell.textContent)) : [];
    const course = cleanText(anchor.textContent) || `课程 ${id}`;
    const term = cells[3] || "";
    const role = cells[4] || "";
    const published = cells[5] || "";
    const item = {id, course, term, role, published, url: `https://oc.sjtu.edu.cn/courses/${id}`};
    if (!courses.has(id) || item.course.length > courses.get(id).course.length) courses.set(id, item);
  }
  return [...courses.values()];
}

function canvasVideoLinkFromPage(course) {
  const candidates = [...document.querySelectorAll("a[href]")].map(anchor => {
    const text = cleanText(`${anchor.textContent} ${anchor.getAttribute("title") || ""} ${anchor.getAttribute("aria-label") || ""}`);
    const url = absoluteUrl(anchor.getAttribute("href")).replace(/#.*$/, "");
    return {text, url};
  }).filter(item => {
    const isClassVideo = /课堂\s*视频|课堂视频|class\s*video/i.test(item.text);
    const isLaunchUrl = /\/courses\/\d+\/external_tools\/\d+/.test(item.url) || item.url.includes("v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/");
    return isClassVideo && isLaunchUrl;
  }).sort((a, b) => {
    const score = value => (/new/i.test(value.text) || /新版/.test(value.text) ? 0 : 1);
    return score(a) - score(b);
  });
  const selected = candidates[0];
  if (!selected) return null;
  const courseId = canvasCourseId(selected.url) || canvasCourseId(location.href);
  return {
    url: selected.url,
    course: course || cleanText(document.querySelector("nav[aria-label='breadcrumbs'] a[href*='/courses/']")?.textContent) || document.title,
    courseId,
    label: selected.text || "课堂视频new"
  };
}

function waitForSelectedReplay(selected, previousCaption, allowSameCaption, sendResponse, deadline, acceptAfter) {
  const card = document.getElementById(selected.id);
  const captions = captionRows();
  const summary = platformSummary();
  const firstCaption = captions[0]?.text || "";
  const isSelected = card?.classList.contains("selected");
  const changed = firstCaption && firstCaption !== previousCaption;
  const hasContent = captions.length || summary.overview || summary.chapters.length;
  const settled = Date.now() >= acceptAfter;
  if (isSelected && hasContent && (changed || allowSameCaption || settled)) {
    sendResponse({
      schemaVersion: 3,
      source: "v.sjtu.edu.cn-platform-captions",
      time: selected.time,
      course: pageMetadata().course,
      teacher: pageMetadata().teacher,
      replayLabel: selected.label,
      captions,
      platformSummary: summary,
      capturedAt: new Date().toISOString()
    });
    return;
  }
  if (Date.now() >= deadline) {
    sendResponse({error: hasContent ? "概要没有切换到所选节次，请重试。" : "所选节次暂未生成字幕或概要。"});
    return;
  }
  setTimeout(() => waitForSelectedReplay(selected, previousCaption, allowSameCaption, sendResponse, deadline, acceptAfter), 500);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "extractCanvasCourses") {
    sendResponse({courses: canvasCoursesFromPage(), url: location.href, title: document.title});
    return false;
  }
  if (message.action === "extractCanvasVideoLink") {
    sendResponse({videoLink: canvasVideoLinkFromPage(message.course), url: location.href, title: document.title});
    return false;
  }

  const replays = replayRows();
  if (!replays.length) return false;

  if (message.action === "listReplays") {
    sendResponse({replays, metadata: pageMetadata()});
    return false;
  }
  if (message.action !== "extractCaptions") return false;

  const selected = replays.find(item => item.time === message.time);
  const card = selected && document.getElementById(selected.id);
  if (!selected || !card) {
    sendResponse({error: "找不到所选回放，请刷新页面后重试。"});
    return false;
  }
  const previousCaption = captionRows()[0]?.text || "";
  const alreadySelected = card.classList.contains("selected");
  const clickTarget = card.querySelector(".list-item__right") || card;
  clickTarget.click();
  const now = Date.now();
  waitForSelectedReplay(selected, previousCaption, alreadySelected, sendResponse, now + 30000, now + 1800);
  return true;
});
}

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {parseHTML} = require("linkedom");
const platform = require("../chrome-extension/video-platform.js");
const qr = require("../chrome-extension/qr-core.js");
const extension = path.resolve(__dirname, "../chrome-extension");
const modern = "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui/#/play-center?course-context";
const old = "https://v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/#/play";
const read = name => fs.readFileSync(path.join(extension, name), "utf8");

// Reconstructed from the modern published CourseList / AiCaption / Summarize
// render functions, not a browser or a live logged-in course response.
const fixture = `<html><head><title>课堂实录</title></head><body>
<header><div class="tecl-info"><div class="top sle">高等数学</div><div class="bottom"><div class="sle">教师甲</div></div></div></header>
<main class="video-page-wrapper"><div class="course-list-wrapper"><div class="list-wrap">
<div class="list-item student selected" id="list-item-0"><div class="list-item__right"><div class="title">第十周第一节</div><div class="bottom-left" title="2026-11-03 08:00 教室甲">2026-11-03 08:00 教室甲</div></div></div>
<div class="list-item student" id="list-item-1"><div class="list-item__right"><div class="title">第十周第二节</div><div class="bottom-left">2026-11-03 09:00 教室甲</div></div></div>
<div class="list-item student can-not-play" id="list-item-2">2026-11-03 10:00 未生成录像</div>
<div class="list-item student disabled" id="list-item-3">2026-11-03 11:00 老师关闭</div>
</div></div><div class="ai-caption-wrapper"><div class="caption-card"><span class="time-wrapper"><span class="time">00:00:05</span></span><span class="caption-text">第一节</span><span class="caption-text">字幕</span></div></div>
<div class="outline-wrapper"><div class="summary-content">第一节概要</div><div class="chapter-navigation"><div class="skim-wrapper"><div class="skim-time"><span class="time">00:00:10</span></div><div class="skim-title">导数</div><div class="skim-content">导数定义</div></div></div></div></main>
<div class="search-outline-page"><div class="summary-content">不应读取的搜索结果</div></div></body></html>`;

function contentHarness(html = fixture, href = modern) {
  const {document} = parseHTML(html);
  const timers = [];
  let listener;
  let now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const location = {href};
  const context = vm.createContext({document, location, URL, Date: Clock, SJTUVideo: platform,
    setTimeout: fn => timers.push(fn), chrome: {runtime: {onMessage: {addListener: fn => { listener = fn; }}}}});
  vm.runInContext(read("content.js"), context);
  return {
    document, location,
    send(message) { let response; const pending = listener(message, {}, value => { response = value; }); return {pending, response: () => response}; },
    tick(ms = 250) { now += ms; timers.splice(0).forEach(fn => fn()); }
  };
}

test("modern page lists playable records using minute-precision timestamps and current metadata", () => {
  const app = contentHarness();
  const result = app.send({action: "listReplays"}).response();
  assert.deepEqual(Array.from(result.replays, item => item.time), ["2026-11-03 08:00:00", "2026-11-03 09:00:00"]);
  assert.equal(result.metadata.platform, "resourcemanage");
  assert.equal(result.metadata.course, "高等数学");
  assert.equal(result.metadata.teacher, "教师甲");
  assert.ok(result.metadata.sourceKey);
  assert.equal(result.replays.length, 2);
});

test("modern captions and outline exclude the independent search result panel", () => {
  const app = contentHarness();
  const rows = app.send({action: "listReplays"}).response();
  const request = app.send({action: "extractCaptions", ...rows.replays[0], sourceKey: rows.metadata.sourceKey});
  assert.equal(request.pending, true);
  for (let step = 0; step < 4; step++) app.tick();
  const result = request.response();
  assert.equal(result.captions[0].start, "00:00:05");
  assert.equal(result.captions[0].text, "第一节字幕");
  assert.equal(result.platformSummary.overview, "第一节概要");
  assert.equal(result.platformSummary.chapters[0].start, "00:00:10");
  assert.equal(result.platformSummary.chapters[0].title, "导数");
  assert.equal(result.source, "v.sjtu.edu.cn-resourcemanage-platform-captions");
});

test("switching recordings never returns an unchanged previous caption after a fixed grace period", () => {
  const app = contentHarness();
  const rows = app.send({action: "listReplays"}).response();
  app.document.querySelector("#list-item-1 .list-item__right").click = () => {
    app.document.getElementById("list-item-0").classList.remove("selected");
    app.document.getElementById("list-item-1").classList.add("selected");
  };
  const request = app.send({action: "extractCaptions", ...rows.replays[1], sourceKey: rows.metadata.sourceKey});
  app.tick(3000);
  assert.equal(request.response(), undefined);
  app.document.querySelector(".caption-text").textContent = "第二节";
  app.document.querySelector(".outline-wrapper .summary-content").textContent = "第二节概要";
  for (let step = 0; step < 5; step++) app.tick();
  assert.equal(request.response().captions[0].text, "第二节字幕");
});

test("old platform and stale course identity are rejected instead of reading another page", () => {
  const previous = contentHarness(fixture, old);
  assert.match(previous.send({action: "listReplays"}).response().error, /新版/);
  const app = contentHarness();
  const rows = app.send({action: "listReplays"}).response();
  app.location.href = modern + "-different-class";
  assert.match(app.send({action: "extractCaptions", ...rows.replays[0], sourceKey: rows.metadata.sourceKey}).response().error, /已切换/);
});

test("ambiguous dates require a record ID; disabled and invalid dates cannot be exported", () => {
  const html = fixture.replaceAll("2026-11-03 08:00", "2026-11-03").replace("2026-11-03 09:00", "2026-11-03");
  const app = contentHarness(html);
  assert.match(app.send({action: "extractCaptions", time: "2026-11-03"}).response().error, /回放列表已改变/);
  const invalid = contentHarness(fixture.replaceAll("2026-11-03", "2026-02-31"));
  assert.equal(invalid.send({action: "listReplays"}).response().replays.length, 0);
});

test("manifest covers the modern player and Canvas iframe, and no longer injects into the old player", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const pattern = "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui/*";
  assert.ok(manifest.host_permissions.includes(pattern));
  for (const file of ["content.js", "qr-content.js"]) {
    const script = manifest.content_scripts.find(item => item.js.includes(file));
    assert.ok(script.matches.includes(pattern));
    assert.equal(script.all_frames, true);
    assert.equal(script.matches.some(value => value.includes("canvas-sjtu-ui")), false);
  }
  assert.ok(manifest.content_scripts.find(item => item.js.includes("qr-content.js")).matches.includes("https://oc.sjtu.edu.cn/courses/*"));
});

test("QR background accepts the modern source and rejects legacy and lookalike sources", async () => {
  let listener;
  const notifications = [];
  const store = {};
  const chrome = {
    runtime: {getURL: name => `chrome-extension://test/${name}`, onMessage: {addListener: fn => { listener = fn; }}},
    storage: {local: {get: async () => ({qrSettings: {enabled: true, sound: false}})},
      session: {get: async () => store, set: async data => Object.assign(store, data)}},
    notifications: {getPermissionLevel: async () => "granted", create: async (id, options) => notifications.push({id, options}), onClicked: {addListener() {}}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}
  };
  const context = vm.createContext({chrome, SJTUVideo: platform, SJTUQR: qr, crypto: require("node:crypto").webcrypto, console});
  vm.runInContext(read("qr-background.js"), context);
  const send = url => new Promise(resolve => listener({action: "qrScan", values: ["attendance-code"]}, {url, tab: {id: 15}, frameId: 3}, resolve));
  assert.equal((await send(modern)).alerts.length, 1);
  assert.equal(notifications.length, 1);
  for (const url of [old, "https://v.sjtu.edu.cn.evil.example/jy-application-resourcemanage-ui/"]) assert.match((await send(url)).error, /来源无效/);
});

async function appHarness({tools, tabs, frameUrl = modern, missingScript = false, unreadyFrame = false} = {}) {
  const nodes = new Map();
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {value: selector === "#provider" ? "deepseek" : "", textContent: "", style: {},
      classList: {add() {}, remove() {}, toggle() {}}, addEventListener() {}, append() {}, replaceChildren() {}});
    return nodes.get(selector);
  };
  const created = [], messages = [], injections = [], requests = [];
  let injected = !missingScript;
  const chrome = {
    storage: {local: {get: async () => ({}), set: async () => {}}},
    runtime: {}, windows: {}, downloads: {},
    tabs: {
      create: async options => { created.push(options); return {id: 5, url: options.url}; },
      update: async (id, options) => ({id, ...options}),
      get: async id => ({id, url: "https://oc.sjtu.edu.cn/courses/94306/external_tools/909"}),
      query: async () => [],
      sendMessage: async (id, message, options) => {
        messages.push({id, message, options});
        if (options.frameId === 9) throw new Error("Frame unresponsive");
        if (!injected) throw new Error("Receiving end does not exist");
        return {metadata: {platform: "resourcemanage", sourceKey: "course-key", course: "高等数学"}, replays: [{id: "list-item-0", time: "2026-11-03 08:00:00"}]};
      }
    },
    scripting: {executeScript: async options => {
      if (options.files) { injections.push(options); injected = true; return []; }
      return [{frameId: 0, result: {url: "https://oc.sjtu.edu.cn/courses/94306/external_tools/909"}},
        ...(unreadyFrame ? [{frameId: 9, result: {url: modern}}] : []), {frameId: 12, result: {url: frameUrl}}];
    }}
  };
  const context = vm.createContext({chrome, SJTUVideo: platform, URL, URLSearchParams, location: {search: ""},
    document: {querySelector: element, querySelectorAll: () => [], addEventListener() {}},
    console: {error() {}, warn() {}}, setTimeout, clearTimeout,
    fetch: async url => {
      requests.push(url);
      if (url.includes("visible_course_nav_tools") && tools === "forbidden") return {ok: false, status: 403};
      const data = url.includes("visible_course_nav_tools") ? tools || [] : url.includes("/tabs?") ? tabs || [] : [];
      return {ok: true, headers: {get: () => ""}, json: async () => data};
    }
  });
  vm.runInContext(read("app.js"), context);
  await new Promise(resolve => setImmediate(resolve));
  return {context, created, messages, injections, requests};
}

test("course resolution uses real navigation after a tools API failure and targets the modern iframe", async () => {
  const app = await appHarness({tools: "forbidden", missingScript: true, tabs: [
    {id: "context_external_tool_18717", label: "课堂视频旧版", html_url: "/courses/94306/external_tools/18717"},
    {id: "context_external_tool_909", label: "课堂视频新版", html_url: "/courses/94306/external_tools/909"}
  ]});
  const page = {courseId: "94306", metadata: {course: "高等数学", term: "2026 秋"}};
  app.context.testPage = page;
  await vm.runInContext("resolveCoursePage(testPage)", app.context);
  assert.equal(app.created[0].url, "https://oc.sjtu.edu.cn/courses/94306/external_tools/909");
  assert.equal(page.frameId, 12);
  assert.equal(page.metadata.term, "2026 秋");
  assert.ok(app.messages.every(item => item.options.frameId === 12));
  assert.deepEqual(Array.from(app.injections[0].target.frameIds), [12]);
  assert.ok(app.injections[0].files.includes("video-platform.js"));
});

test("missing modern navigation never creates a guessed or discontinued player tab", async () => {
  const app = await appHarness({tabs: [{id: "context_external_tool_18717", label: "课堂视频", html_url: "/courses/94306/external_tools/18717"}]});
  app.context.testPage = {courseId: "94306", metadata: {course: "高等数学"}};
  await assert.rejects(vm.runInContext("resolveCoursePage(testPage)", app.context), /未找到这门课的新版/);
  assert.equal(app.created.length, 0);
});

test("a legacy frame cannot supply replays through the modern resolver", async () => {
  const app = await appHarness({frameUrl: old});
  app.context.testTab = {id: 5, url: "https://oc.sjtu.edu.cn/courses/94306/external_tools/909"};
  assert.equal(await vm.runInContext("readModernVideoPage(testTab)", app.context), null);
  assert.equal(app.messages.length, 0);
});

test("one unready modern frame does not hide the real player frame", async () => {
  const app = await appHarness({unreadyFrame: true});
  app.context.testTab = {id: 5, url: "https://oc.sjtu.edu.cn/courses/94306/external_tools/909"};
  const result = await vm.runInContext("readModernVideoPage(testTab)", app.context);
  assert.equal(result.frameId, 12);
  assert.deepEqual(app.messages.map(item => item.options.frameId), [9, 12]);
});

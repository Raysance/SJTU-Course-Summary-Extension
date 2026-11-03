const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {parseHTML} = require("linkedom");
const QR = require("../chrome-extension/qr-core.js");
const platform = require("../chrome-extension/video-platform.js");
const root = path.resolve(__dirname, "../chrome-extension");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const modern = "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui/#/play-center?test";
const jpeg = "data:image/jpeg;base64,AA==";
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

test("preview copies the decoded canvas at a bounded size and never decodes another frame", async () => {
  const saved = {document: global.document, BarcodeDetector: global.BarcodeDetector};
  const draws = [], canvases = [];
  global.document = {createElement: () => {
    const canvas = {width: 0, height: 0, getContext: () => ({drawImage: (...args) => draws.push(args)}), toDataURL: () => jpeg};
    canvases.push(canvas); return canvas;
  }};
  let decodes = 0;
  global.BarcodeDetector = class {
    static async getSupportedFormats() { return ["qr_code"]; }
    async detect() { ++decodes; return [{rawValue: "code"}]; }
  };
  try {
    const scanner = new QR.Scanner();
    assert.equal(scanner.preview(), null);
    const video = {readyState: 2, videoWidth: 1920, videoHeight: 1080, currentTime: 42};
    await scanner.scan(video);
    const preview = scanner.preview();
    assert.equal(preview.image, jpeg);
    assert.equal(preview.mediaTime, 42);
    assert.ok(preview.capturedAt > 0);
    assert.equal(canvases[1].width, 480);
    assert.equal(canvases[1].height, 270);
    assert.equal(draws.at(-1)[0], canvases[0]);
    assert.equal(decodes, 1);
    scanner.busy = true;
    assert.equal(scanner.preview(), null);
    scanner.busy = false;
    scanner.release();
    assert.equal(scanner.preview(), null);
  } finally { Object.assign(global, saved); }
});

function contentHarness({deferred = false} = {}) {
  const {window, document} = parseHTML('<html><head><title>直播</title></head><body><header><div class="tecl-info"><div class="top">高等数学</div></div></header><video id="teacher"></video><video id="slides"></video></body></html>');
  const timers = [], messages = [];
  let listener, change, now = Date.now(), encodes = 0, finish;
  class Clock extends Date { static now() { return now; } }
  class Scanner {
    async scan(video) {
      this.checkedAt = now; this.target = video.id;
      if (deferred) await new Promise(resolve => { finish = resolve; });
      return [];
    }
    preview() { ++encodes; return {image: jpeg, capturedAt: this.checkedAt}; }
    delay() { return 1500; }
    release() {}
  }
  for (const video of document.querySelectorAll("video")) Object.assign(video, {readyState: 4, videoWidth: 1280, videoHeight: 720, paused: false, ended: false, currentSrc: `https://media.test/${video.id}`, srcObject: null});
  const chrome = {storage: {local: {get: async () => ({qrSettings: {enabled: true}})}, onChanged: {addListener: fn => { change = fn; }}},
    runtime: {id: "test", onMessage: {addListener: fn => { listener = fn; }}, sendMessage: async message => { messages.push(message); return {alerts: []}; }}};
  const context = vm.createContext({document, window, chrome, location: {href: modern}, Date: Clock,
    SJTUQR: {...QR, Scanner}, setTimeout: fn => timers.push(fn), clearTimeout() {}});
  vm.runInContext(read("qr-content.js"), context);
  return {document, messages, context, get encodes() { return encodes; },
    preview() { let result; listener({action: "qrGetFramePreviews"}, {}, value => { result = value; }); return plain(result); },
    async tick(ms = 1500) { now += ms; timers.splice(0).forEach(fn => fn()); await flush(); },
    disable() { change({qrSettings: {newValue: {enabled: false}}}, "local"); },
    finish() { finish(); }};
}

test("automatic previews are opt-in, cover multiple videos, and expire when the viewer stops asking", async () => {
  const app = contentHarness(); await flush();
  assert.equal(app.encodes, 0);
  assert.equal(app.preview().items.length, 2);
  await app.tick(); await app.tick();
  const result = app.preview();
  assert.deepEqual(result.items.map(item => item.label), ["画面 1", "画面 2"]);
  assert.ok(result.items.every(item => item.image === jpeg && item.capturedAt > 0));
  assert.equal(app.encodes, 2);
  await app.tick(11000);
  assert.equal(app.encodes, 2);
  assert.ok(app.preview().items.every(item => item.image === ""));
  app.disable();
  assert.deepEqual(app.preview().items, []);
});

test("paused, detached and changed sources never retain a previous screenshot", async () => {
  const app = contentHarness(); await flush(); app.preview(); await app.tick(); await app.tick();
  app.document.getElementById("teacher").paused = true;
  const slides = app.document.getElementById("slides");
  slides.currentSrc = "https://media.test/new-class";
  const result = app.preview();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].image, "");
  slides.remove();
  assert.equal(app.preview().items.length, 0);
});

test("a source changing while native decoding is pending cannot publish a mislabeled preview", async () => {
  const app = contentHarness({deferred: true}); await flush(); app.preview();
  app.document.getElementById("teacher").currentSrc = "https://media.test/another-class";
  app.finish(); await flush();
  assert.equal(app.encodes, 0);
  assert.equal(app.messages.some(message => message.action === "qrScan"), false);
});

function backgroundHarness({hanging = false, invalid = false} = {}) {
  let listener;
  const timers = [], calls = [], now = Date.now();
  const state = {recent: [], gates: [], sources: {
    "1:7": {key: "1:7", tabId: 1, frameId: 7, title: "课程甲", state: "monitoring", checkedAt: now},
    "2:shared": {key: "2:shared", tabId: 2, title: "共享", state: "monitoring", checkedAt: now},
    "3:0": {key: "3:0", tabId: 3, frameId: 0, state: "monitoring", checkedAt: now - 50000}
  }};
  const store = {qrState: state};
  const reply = () => ({items: [{id: "video-1", title: "课程甲", label: "直播画面", image: invalid ? "data:image/svg+xml,unsafe" : jpeg, capturedAt: now, hasCode: true}]});
  const chrome = {
    runtime: {getURL: file => `chrome-extension://test/${file}`, onMessage: {addListener: fn => { listener = fn; }},
      sendMessage: async message => { calls.push(message); return reply(); }},
    tabs: {sendMessage: (id, message, options) => { calls.push({id, message, options}); return hanging ? new Promise(() => {}) : Promise.resolve(reply()); }},
    storage: {local: {get: async () => ({qrSettings: {enabled: true, sound: false}})}, session: {get: async () => store, set: async data => Object.assign(store, data)}},
    notifications: {getPermissionLevel: async () => "granted", create: async () => {}, onClicked: {addListener() {}}},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}
  };
  const context = vm.createContext({chrome, SJTUQR: QR, SJTUVideo: platform, crypto: require("node:crypto").webcrypto,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, console});
  vm.runInContext(read("qr-background.js"), context);
  const send = (action, sender = {url: "chrome-extension://test/app.html", tab: {id: 8}}, extra = {}) => new Promise(resolve => listener({action, ...extra}, sender, resolve));
  return {send, calls, store, timers};
}

test("preview relay targets the scanned frame and shared page, rejects foreign viewers, and persists no images", async () => {
  const app = backgroundHarness();
  const result = await app.send("qrGetPreviews");
  assert.equal(result.items.length, 2);
  const frame = app.calls.find(call => call.id === 1);
  assert.equal(frame.options.frameId, 7);
  assert.equal(frame.message.action, "qrGetFramePreviews");
  assert.ok(app.calls.some(call => call.target === "qr-preview" && call.tabId === 2));
  assert.equal(app.calls.some(call => call.id === 3), false);
  assert.equal(JSON.stringify(app.store).includes("data:image"), false);
  const denied = await app.send("qrGetPreviews", {url: modern, tab: {id: 1}, frameId: 7});
  assert.match(denied.error, /来源无效/);
});

test("preview payloads exclude arbitrary image types and an unresponsive preview cannot delay QR alerts", async () => {
  const invalid = await backgroundHarness({invalid: true}).send("qrGetPreviews");
  assert.ok(invalid.items.every(item => item.image === ""));
  const app = backgroundHarness({hanging: true});
  const pending = app.send("qrGetPreviews"); await flush();
  const alert = await app.send("qrScan", {url: modern, tab: {id: 1}, frameId: 7}, {values: ["new-code"]});
  assert.equal(alert.alerts.length, 1);
  app.timers.forEach(fn => fn());
  assert.equal((await pending).items.length, 1);
});

function panelHarness({hidden = false, pendingPreview = false} = {}) {
  const {window, document} = parseHTML(read("app.html"));
  Object.defineProperty(document, "hidden", {value: hidden, writable: true});
  const calls = [], timers = [];
  let changed, resolvePreview;
  const state = {settings: {...QR.DEFAULTS, enabled: true}, recent: [], sources: [{state: "monitoring", checkedAt: Date.now()}]};
  const previews = {items: [{id: "1:0:video-1", title: "高等数学", label: "画面 1", image: jpeg, capturedAt: Date.now(), hasCode: false}], hasMore: false};
  const chrome = {storage: {onChanged: {addListener: fn => { changed = fn; }}}, runtime: {sendMessage: async message => {
    calls.push(message.action);
    if (message.action === "qrGetState") return plain(state);
    if (message.action === "qrGetPreviews") return pendingPreview ? new Promise(resolve => { resolvePreview = resolve; }) : plain(previews);
    if (message.action === "qrSetSettings") { state.settings = message.settings; return {settings: state.settings}; }
  }}};
  vm.runInContext(read("qr-panel.js"), vm.createContext({document, chrome, SJTUQR: QR, console, setInterval: fn => timers.push(fn)}));
  return {window, document, calls, state, previews, timers,
    change(value) { state.settings.enabled = value; changed({qrSettings: {newValue: state.settings}}, "local"); },
    resolve() { resolvePreview(plain(previews)); }};
}

test("reminder panel shows actual checked frame, origin and result without adding settings", async () => {
  const app = panelHarness(); await flush();
  assert.equal(app.document.querySelector("#qr-preview").classList.contains("hidden"), false);
  assert.equal(app.document.querySelector("#qr-preview-grid img").getAttribute("src"), jpeg);
  assert.match(app.document.querySelector("#qr-preview-grid").textContent, /高等数学.*画面 1.*最近检查.*本次未识别到二维码/);
  assert.equal(app.document.querySelectorAll(".qr-card input").length, 1);
  assert.equal(app.document.querySelectorAll(".qr-card select").length, 0);
  app.change(false); await flush();
  assert.equal(app.document.querySelectorAll("#qr-preview-grid img").length, 0);
  assert.equal(app.document.querySelector("#qr-preview").classList.contains("hidden"), true);
});

test("hidden reminder pages do not request thumbnails, and late replies cannot undo disabling", async () => {
  const hidden = panelHarness({hidden: true}); await flush();
  assert.equal(hidden.calls.includes("qrGetPreviews"), false);
  hidden.document.hidden = false;
  hidden.document.dispatchEvent(new hidden.window.Event("visibilitychange")); await flush();
  assert.equal(hidden.calls.includes("qrGetPreviews"), true);
  const app = panelHarness({pendingPreview: true}); await flush();
  app.change(false); await flush(); app.resolve(); await flush();
  assert.equal(app.document.querySelectorAll("#qr-preview-grid img").length, 0);
  assert.equal(app.document.querySelector("#qr-preview").classList.contains("hidden"), true);
});

test("shared capture previews belong to the right page and stop with the capture", async () => {
  const {window, document} = parseHTML(read("qr-monitor.html"));
  const video = document.getElementById("share-video");
  Object.assign(video, {readyState: 4, videoWidth: 960, videoHeight: 540, paused: false, play: async () => {}});
  const timers = [];
  let listener, now = Date.now(), encodes = 0;
  const track = {readyState: "live", stop() { this.readyState = "ended"; }, addEventListener() {}};
  const stream = {getTracks: () => [track], getVideoTracks: () => [track]};
  class Clock extends Date { static now() { return now; } }
  class Scanner {
    async scan() { this.checkedAt = now; return ["shared-code"]; }
    preview() { ++encodes; return {image: jpeg, capturedAt: this.checkedAt}; }
    delay() { return 1500; }
    release() {}
  }
  const chrome = {tabs: {getCurrent: async () => ({id: 22})},
    storage: {local: {get: async () => ({})}, onChanged: {addListener() {}}},
    runtime: {onMessage: {addListener: fn => { listener = fn; }}, sendMessage: async message => message.action === "qrSetSettings" ? {settings: message.settings} : {alerts: []}}};
  const context = vm.createContext({document, window, chrome, Date: Clock, SJTUQR: {...QR, Scanner}, CustomEvent: window.CustomEvent,
    navigator: {mediaDevices: {getDisplayMedia: async () => stream}}, setTimeout: fn => timers.push(fn), clearTimeout() {}, console});
  vm.runInContext(read("qr-monitor.js"), context); await flush();
  document.getElementById("share-start").dispatchEvent(new window.Event("click")); await flush();
  const preview = tabId => {
    let result;
    listener({target: "qr-preview", action: "qrGetSharedPreview", tabId}, {}, value => { result = value; });
    return result && plain(result);
  };
  assert.equal(encodes, 0);
  assert.equal(preview(99), undefined);
  assert.equal(preview(22).items[0].image, "");
  now += 1500; timers.splice(0).forEach(fn => fn()); await flush();
  assert.equal(preview(22).items[0].image, jpeg);
  assert.equal(preview(22).items[0].hasCode, true);
  assert.equal(encodes, 1);
  assert.equal(video.classList.contains("hidden"), true);
  document.getElementById("share-stop").dispatchEvent(new window.Event("click")); await flush();
  assert.equal(track.readyState, "ended");
  assert.deepEqual(preview(22).items, []);
});

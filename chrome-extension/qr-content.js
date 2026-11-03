(() => {
  if (globalThis.__SJTU_QR_MONITOR__) return;
  globalThis.__SJTU_QR_MONITOR__ = true;
  let config = SJTUQR.settings();
  let timer;
  let generation = 0;
  let settingsRevision = 0;
  let scanner;
  let scanning = false;
  let cursor = 0;
  let lastStatus = "";
  let lastReport = 0;
  let toast;
  let previewUntil = 0;
  let nextVideoId = 0;
  const videoIds = new WeakMap();
  const previews = new Map();
  // Do not repeatedly read a tainted canvas or retry it on every tick.
  const blocked = new WeakMap();

  function pageTitle() {
    return document.querySelector("header .tecl-info .top")?.textContent.trim() || document.title;
  }

  function activeVideos() {
    return [...document.querySelectorAll("video")].filter(video => video.isConnected && video.readyState >= 2 && video.videoWidth >= 64 && !video.paused && !video.ended);
  }

  function clearPreviews() {
    previewUntil = 0;
    previews.clear();
  }

  async function send(message) {
    return chrome.runtime.sendMessage({...message, title: pageTitle()});
  }

  async function status(state, detail) {
    const key = `${state}:${detail}`;
    if (key === lastStatus && Date.now() - lastReport < 15000) return;
    lastStatus = key;
    lastReport = Date.now();
    await send({action: "qrStatus", state, detail});
  }

  function showAlert(records, warning) {
    toast?.remove();
    toast = document.createElement("div");
    const shadow = toast.attachShadow({mode: "closed"});
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;position:fixed;right:20px;top:20px;z-index:2147483647;width:min(360px,90vw);font:14px/1.6 system-ui,sans-serif;color:#17233c}section{padding:18px;border:2px solid #1766df;border-radius:14px;background:#fff;box-shadow:0 10px 40px #0003}strong{font-size:17px}p{margin:8px 0;overflow-wrap:anywhere}button{padding:6px 12px;border:0;border-radius:8px;background:#1766df;color:#fff;cursor:pointer}small{display:block;color:#8a4b13}";
    const section = document.createElement("section");
    section.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "直播画面出现二维码";
    const text = document.createElement("p");
    text.textContent = records.map(item => item.value.slice(0, 220)).join("\n");
    const close = document.createElement("button");
    close.textContent = "知道了";
    close.addEventListener("click", () => toast?.remove());
    section.append(title, text, close);
    if (warning) {
      const note = document.createElement("small");
      note.textContent = warning;
      section.append(note);
    }
    shadow.append(style, section);
    (document.fullscreenElement || document.documentElement).append(toast);
  }

  async function tick(token) {
    if (!config.enabled || token !== generation) return;
    if (scanning) {
      timer = setTimeout(() => tick(token), 250);
      return;
    }
    scanning = true;
    let delay = config.intervalMs;
    try {
      const videos = activeVideos();
      if (Date.now() >= previewUntil) previews.clear();
      for (const video of previews.keys()) if (!videos.includes(video)) previews.delete(video);
      const available = videos.filter(video => {
        const previous = blocked.get(video);
        return !previous || previous.src !== video.currentSrc || previous.stream !== video.srcObject;
      });
      if (!videos.length) {
        await status("waiting", "等待正在播放的直播视频");
      } else if (!available.length) {
        await status("blocked", "请在扩展中选择直播画面");
      } else {
        scanner ||= new SJTUQR.Scanner();
        const video = available[cursor++ % available.length];
        const input = {src: video.currentSrc, stream: video.srcObject, href: location.href, title: pageTitle()};
        let values;
        try {
          values = await scanner.scan(video);
        } catch (error) {
          if (error.name !== "SecurityError") throw error;
          blocked.set(video, {src: video.currentSrc, stream: video.srcObject});
          scanner.release();
          scanner = null;
          await status("blocked", "请在扩展中选择直播画面");
          return;
        }
        if (token !== generation) return;
        if (!video.isConnected || video.paused || video.ended || input.src !== video.currentSrc || input.stream !== video.srcObject || input.href !== location.href || input.title !== pageTitle()) {
          previews.delete(video);
          return;
        }
        if (Date.now() < previewUntil) {
          const preview = scanner.preview();
          if (preview) previews.set(video, {...preview, hasCode: values.length > 0, title: pageTitle(), currentSrc: video.currentSrc, stream: video.srcObject, href: location.href});
          else previews.delete(video);
        }
        delay = scanner.delay(config);
        const result = await send({action: "qrScan", values, state: "monitoring", detail: `${scanner.engine} · 检查间隔 ${(delay / 1000).toFixed(1)} 秒 · 上次解码 ${scanner.durationMs} ms`});
        if (token !== generation || !config.enabled) return;
        if (result?.error) throw new Error(result.error);
        if (result?.alerts?.length) showAlert(result.alerts, result.warning);
      }
    } catch (error) {
      if (!chrome.runtime?.id) return;
      try { await status("error", `监测暂不可用：${error.message}`); } catch { return; }
      delay = Math.max(5000, delay);
    } finally {
      scanning = false;
      if (token === generation && config.enabled && chrome.runtime?.id) timer = setTimeout(() => tick(token), delay);
    }
  }

  function apply(value) {
    config = SJTUQR.settings(value);
    clearTimeout(timer);
    const token = ++generation;
    if (config.enabled) {
      tick(token);
    } else {
      scanner?.release();
      scanner = null;
      clearPreviews();
      toast?.remove();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.qrSettings) {
      ++settingsRevision;
      apply(changes.qrSettings.newValue);
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== "qrGetFramePreviews") return false;
    if (!config.enabled) { sendResponse({items: []}); return false; }
    previewUntil = Date.now() + 10000;
    const allVideos = activeVideos().filter(video => {
      const previous = blocked.get(video);
      return !previous || previous.src !== video.currentSrc || previous.stream !== video.srcObject;
    });
    const videos = allVideos.slice(0, 4);
    const items = videos.map((video, index) => {
      if (!videoIds.has(video)) videoIds.set(video, `video-${++nextVideoId}`);
      const cached = previews.get(video);
      const valid = cached && cached.currentSrc === video.currentSrc && cached.stream === video.srcObject && cached.href === location.href && cached.title === pageTitle();
      return {id: videoIds.get(video), title: pageTitle(), label: videos.length > 1 ? `画面 ${index + 1}` : "直播画面",
        image: valid ? cached.image : "", capturedAt: valid ? cached.capturedAt : 0,
        hasCode: valid && cached.hasCode};
    });
    sendResponse({items, hasMore: allVideos.length > videos.length});
    return false;
  });
  const initialRevision = settingsRevision;
  chrome.storage.local.get("qrSettings").then(saved => {
    if (settingsRevision === initialRevision) apply(saved.qrSettings);
  });
  window.addEventListener("pagehide", () => { ++generation; clearTimeout(timer); scanner?.release(); scanner = null; clearPreviews(); });
  window.addEventListener("pageshow", event => {
    if (event.persisted) chrome.storage.local.get("qrSettings").then(saved => apply(saved.qrSettings));
  });
})();

(() => {
  const video = document.getElementById("share-video");
  const start = document.getElementById("share-start");
  const stop = document.getElementById("share-stop");
  const status = document.getElementById("share-status");
  const result = document.getElementById("share-result");
  let config = SJTUQR.settings();
  let stream;
  let scanner;
  let timer;
  let generation = 0;
  let settingsRevision = 0;
  let pending = false;
  let ownTabId;
  let previewUntil = 0;
  let lastPreview = null;
  const tabReady = chrome.tabs.getCurrent().then(tab => { ownTabId = tab?.id; });

  function sharingState(active, pending = false, message = "", error = false) {
    document.dispatchEvent(new CustomEvent("sjtu-qr-sharing", {detail: {active, pending, message, error}}));
  }

  function stopSharing(text = "已停止共享直播画面。", error = false) {
    ++generation;
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    video.classList.add("hidden");
    result.classList.add("hidden");
    scanner?.release();
    scanner = null;
    previewUntil = 0;
    lastPreview = null;
    start.disabled = false;
    stop.disabled = true;
    status.textContent = text;
    sharingState(false, false, text, error);
    chrome.runtime.sendMessage({action: "qrStatus", state: "stopped", title: "共享画面", detail: text}).catch(() => {});
  }

  async function tick(token) {
    if (!stream || token !== generation || !config.enabled) return;
    let delay = config.intervalMs;
    try {
      if (video.readyState < 2) {
        lastPreview = null;
        status.textContent = "正在连接直播画面…";
      } else {
        const values = await scanner.scan(video);
        if (token !== generation) return;
        if (Date.now() < previewUntil) {
          const preview = scanner.preview();
          lastPreview = preview ? {...preview, hasCode: values.length > 0} : null;
        } else lastPreview = null;
        delay = scanner.delay(config);
        const detail = `${scanner.engine} · 检查间隔 ${(delay / 1000).toFixed(1)} 秒 · 上次解码 ${scanner.durationMs} ms`;
        status.textContent = "正在监测这段直播，二维码出现时会提醒你。";
        const reply = await chrome.runtime.sendMessage({action: "qrScan", values, state: "monitoring", title: "共享直播画面", detail});
        if (token !== generation || !config.enabled) return;
        if (reply?.error) throw new Error(reply.error);
        if (reply?.alerts?.length) {
          result.textContent = `发现二维码，已提醒你。${reply.warning ? ` ${reply.warning}` : ""}`;
          result.classList.remove("hidden");
        }
      }
    } catch (error) {
      if (token !== generation) return;
      console.warn("共享直播监测异常", error);
      status.textContent = "画面暂时无法读取，正在重试。也可以停止共享后重新选择。";
      delay = Math.max(5000, delay);
    } finally {
      if (stream && token === generation && config.enabled) timer = setTimeout(() => tick(token), delay);
    }
  }

  start.addEventListener("click", async () => {
    if (pending || stream) return;
    pending = true;
    start.disabled = true;
    status.textContent = "请选择正在播放的直播画面。";
    sharingState(true, true);
    const token = ++generation;
    let selected;
    try {
      // Invoke immediately within the click; the chooser always needs a user gesture.
      selected = await navigator.mediaDevices.getDisplayMedia({
        video: {width: {ideal: 960}, height: {ideal: 540}, frameRate: {ideal: 2, max: 5}}, audio: false, selfBrowserSurface: "exclude"
      });
      if (token !== generation) { selected.getTracks().forEach(track => track.stop()); return; }
      stream = selected;
      video.srcObject = stream;
      stream.getVideoTracks()[0].addEventListener("ended", () => stopSharing(), {once: true});
      await video.play();
      await tabReady;
      const saved = await chrome.runtime.sendMessage({action: "qrSetSettings", settings: {...SJTUQR.DEFAULTS, enabled: true}});
      if (saved?.error) throw new Error(saved.error);
      if (token !== generation) return;
      config = SJTUQR.settings(saved.settings);
      scanner = new SJTUQR.Scanner();
      stop.disabled = false;
      result.textContent = "";
      sharingState(true);
      tick(token);
    } catch (error) {
      selected?.getTracks().forEach(track => track.stop());
      if (token !== generation) return;
      console.warn("未能开始共享直播", error);
      stopSharing(error.name === "NotAllowedError" ? "尚未选择直播画面，你可以稍后再试。" : "未能读取直播画面，请重新选择。", error.name !== "NotAllowedError");
    } finally {
      pending = false;
      start.disabled = Boolean(stream);
    }
  });
  stop.addEventListener("click", () => stopSharing());
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "qr-preview" || message.action !== "qrGetSharedPreview" || message.tabId !== ownTabId) return false;
    if (!config.enabled || !stream || video.readyState < 2 || video.paused) { lastPreview = null; sendResponse({items: []}); return false; }
    previewUntil = Date.now() + 10000;
    sendResponse({items: [{id: "shared", title: "已选择的直播画面", label: "共享画面",
      image: lastPreview?.image || "", capturedAt: lastPreview?.capturedAt || 0, hasCode: lastPreview?.hasCode === true}]});
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.qrSettings) return;
    ++settingsRevision;
    config = SJTUQR.settings(changes.qrSettings.newValue);
    if (!config.enabled && (stream || pending)) stopSharing("");
  });
  window.addEventListener("pagehide", () => stopSharing(""));
  const initialRevision = settingsRevision;
  chrome.storage.local.get("qrSettings").then(saved => {
    if (settingsRevision === initialRevision) config = SJTUQR.settings(saved.qrSettings);
  });
})();

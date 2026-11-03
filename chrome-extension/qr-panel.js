(() => {
  const find = id => document.getElementById(id);
  const standalone = document.body.classList.contains("qr-monitor-page");
  let revision = 0;
  let waitingSince = 0;
  let sharing = false;
  let pending = false;
  let lastHistory = "";

  function feedback(text = "", error = false) {
    const node = find("qr-feedback");
    node.textContent = text;
    node.classList.toggle("hidden", !text);
    node.classList.toggle("error", error);
  }

  async function request(action, extra = {}) {
    const result = await chrome.runtime.sendMessage({action, ...extra});
    if (!result || result.error) throw new Error(result?.error || "扩展后台未响应");
    return result;
  }

  function renderHistory(records) {
    const signature = JSON.stringify(records);
    if (signature === lastHistory) return;
    lastHistory = signature;
    find("qr-history-panel").classList.toggle("hidden", !records.length);
    const root = find("qr-history");
    root.replaceChildren();
    for (const record of records) {
      const row = document.createElement("div");
      row.className = "qr-record";
      const meta = document.createElement("small");
      meta.textContent = `${new Date(record.detectedAt).toLocaleTimeString()} · ${record.title}`;
      const text = document.createElement("p");
      text.textContent = record.value;
      const source = document.createElement("button");
      source.className = "secondary";
      source.textContent = "返回直播";
      source.addEventListener("click", async () => {
        try {
          const tab = await chrome.tabs.update(record.tabId, {active: true});
          await chrome.windows.update(tab.windowId, {focused: true});
        } catch { feedback("这段直播已经关闭。", true); }
      });
      row.append(meta, text, source);
      const url = SJTUQR.safeHttpUrl(record.value);
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "打开链接";
        row.append(link);
      }
      root.append(row);
    }
  }

  async function refresh() {
    const started = revision;
    try {
      const result = await request("qrGetState");
      if (started !== revision) return;
      const enabled = result.settings.enabled;
      const control = find("qr-enabled");
      if (control) control.checked = enabled;
      const monitoring = result.sources.some(source => source.state === "monitoring");
      const needsSelection = result.sources.some(source => ["blocked", "error"].includes(source.state));
      if (enabled && !monitoring) waitingSince ||= Date.now();
      else waitingSince = 0;
      const waited = waitingSince && Date.now() - waitingSince >= 15000;
      const showStart = !sharing && (standalone || enabled && (needsSelection || waited));
      const showStop = sharing && !pending;
      find("share-start").classList.toggle("hidden", !showStart);
      find("share-stop").classList.toggle("hidden", !showStop);
      find("qr-capture-actions").classList.toggle("hidden", !showStart && !showStop);
      find("share-status").classList.toggle("hidden", !sharing);
      const root = find("qr-sources");
      root.classList.toggle("hidden", sharing);
      let text;
      if (standalone) text = "选择正在播放的直播画面即可开始提醒。";
      else if (!enabled) text = "提醒已关闭。";
      else if (needsSelection) text = monitoring ? "正在监测直播。还有部分画面需要你选择一次。" : "这段直播需要你选择一次画面。";
      else if (monitoring) text = "正在留意直播，二维码出现时会提醒你。";
      else text = waited ? "还没找到直播，你可以选择正在播放的画面。" : "已开启，等待直播播放。";
      if (root.textContent !== text) root.textContent = text;
      renderHistory(result.recent);
    } catch (error) {
      console.warn("二维码提醒暂不可用", error);
      feedback("暂时无法更新，请重新加载扩展后重试。", true);
    }
  }

  find("qr-enabled")?.addEventListener("change", async () => {
    ++revision;
    waitingSince = 0;
    feedback();
    try {
      // One user choice; use the same automatic policy on every start.
      await request("qrSetSettings", {settings: {...SJTUQR.DEFAULTS, enabled: find("qr-enabled").checked}});
    } catch (error) {
      console.warn("无法切换二维码提醒", error);
      feedback("暂时无法切换，请重新加载扩展后重试。", true);
    }
    await refresh();
  });
  document.addEventListener("sjtu-qr-sharing", event => {
    sharing = event.detail.active;
    pending = event.detail.pending === true;
    ++revision;
    feedback(event.detail.message || "", event.detail.error);
    refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.qrSettings) { ++revision; refresh(); }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 3000);
  refresh();
})();

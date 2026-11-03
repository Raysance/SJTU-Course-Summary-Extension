(() => {
  const {settings, observe} = SJTUQR;
  let queue = Promise.resolve();
  let creatingAudio;

  function extensionPage(sender) {
    return ["app.html", "qr-monitor.html"].some(path => sender.url?.split("?")[0] === chrome.runtime.getURL(path));
  }

  function videoPage(sender) {
    return SJTUVideo.isModernUrl(sender.url || "") || Boolean(SJTUVideo.courseIdFromUrl(sender.url || ""));
  }

  async function previewRequest(source) {
    let timer;
    try {
      const shared = source.key.endsWith(":shared");
      const frameId = source.frameId ?? Number(source.key.split(":").at(-1));
      if (!shared && (!Number.isInteger(frameId) || frameId < 0)) return {items: []};
      const request = shared
        ? chrome.runtime.sendMessage({target: "qr-preview", action: "qrGetSharedPreview", tabId: source.tabId})
        : chrome.tabs.sendMessage(source.tabId, {action: "qrGetFramePreviews"}, {frameId});
      const result = await Promise.race([request, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
      if (!Array.isArray(result?.items)) return {items: []};
      const items = result.items.filter(item => item && typeof item === "object").slice(0, 4).map((item, index) => {
        const image = typeof item.image === "string" && item.image.length <= 200000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image) ? item.image : "";
        return {
          id: `${source.key}:${String(item.id || index).slice(0, 40)}`, tabId: source.tabId,
          title: String(item.title || source.title || "直播画面").slice(0, 160),
          label: String(item.label || "直播画面").slice(0, 40), image,
          capturedAt: image && Number.isFinite(item.capturedAt) && item.capturedAt > 0 && item.capturedAt <= Date.now() + 1000 ? item.capturedAt : 0,
          hasCode: Boolean(image && item.hasCode)
        };
      }).filter(item => !item.image || item.capturedAt);
      return {items, hasMore: result.hasMore === true};
    } catch { return {items: []}; }
    finally { clearTimeout(timer); }
  }

  async function getPreviews() {
    const {qrSettings} = await chrome.storage.local.get("qrSettings");
    if (!settings(qrSettings).enabled) return {items: [], hasMore: false};
    const {qrState} = await chrome.storage.session.get("qrState");
    const sources = Object.values(qrState?.sources || {}).filter(source => source.state === "monitoring" && Date.now() - source.checkedAt <= 45000)
      .sort((a, b) => b.checkedAt - a.checkedAt);
    const results = await Promise.allSettled(sources.slice(0, 6).map(previewRequest));
    const items = results.flatMap(result => result.status === "fulfilled" ? result.value.items : []);
    // Images are relayed only to the visible extension page, never persisted.
    return {items, hasMore: sources.length > 6 || results.some(result => result.status === "fulfilled" && result.value.hasMore)};
  }

  async function getPlaybackPurpose(sender) {
    const keys = [SJTUPlayer.purposeKey(sender.tab.id)];
    if (Number.isInteger(sender.tab.openerTabId)) keys.push(SJTUPlayer.purposeKey(sender.tab.openerTabId));
    const saved = await chrome.storage.session.get(keys);
    return {purpose: keys.some(key => saved[key] === "replay") ? "replay" : "live"};
  }

  async function playSound() {
    try {
      const url = chrome.runtime.getURL("qr-audio.html");
      const existing = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url]});
      if (!existing.length) {
        if (!creatingAudio) {
          creatingAudio = chrome.offscreen.createDocument({
            url: "qr-audio.html", reasons: ["AUDIO_PLAYBACK"], justification: "播放检测到直播二维码的短提示音"
          }).finally(() => { creatingAudio = null; });
        }
        await creatingAudio;
      }
      const result = await chrome.runtime.sendMessage({target: "qr-audio", action: "qrPlaySound"});
      if (result?.error) throw new Error(result.error);
      return "";
    } catch (error) {
      return `提示音未播放：${error.message}`;
    }
  }

  async function notify(record, sound) {
    const warnings = [];
    try {
      if (await chrome.notifications.getPermissionLevel() === "denied") {
        warnings.push("桌面通知被禁用，请检查 Chrome 和系统通知设置。");
      } else {
        await chrome.notifications.create(`sjtu-qr:${record.id}`, {
          type: "basic", iconUrl: "assets/qr-notification.png", title: "直播画面出现二维码",
          message: `${record.title.slice(0, 80)}\n${record.value.slice(0, 180)}`,
          contextMessage: "点击返回监测页面", priority: 2, requireInteraction: true
        });
      }
    } catch (error) {
      warnings.push(`桌面通知失败：${error.message}`);
    }
    if (sound) {
      const warning = await playSound();
      if (warning) warnings.push(warning);
    }
    try {
      await chrome.action.setBadgeBackgroundColor({tabId: record.tabId, color: "#1766df"});
      await chrome.action.setBadgeText({tabId: record.tabId, text: "QR"});
    } catch { /* The source tab may have just closed. */ }
    return warnings.join(" ");
  }

  async function handle(message, sender) {
    const saved = await chrome.storage.local.get("qrSettings");
    const config = settings(saved.qrSettings);
    const stored = await chrome.storage.session.get("qrState");
    const state = stored.qrState || {recent: [], sources: {}, gates: []};
    const now = Date.now();
    for (const [key, source] of Object.entries(state.sources)) {
      if (now - source.checkedAt > 45000) delete state.sources[key];
    }

    if (message.action === "qrGetState") {
      return {settings: config, recent: state.recent, sources: Object.values(state.sources)};
    }
    if (message.action === "qrSetSettings") {
      const next = settings({...config, ...message.settings});
      await chrome.storage.local.set({qrSettings: next});
      if (next.enabled !== config.enabled) {
        state.sources = {};
        state.gates = [];
        await chrome.storage.session.set({qrState: state});
      }
      return {settings: next};
    }
    if (message.action === "qrClearHistory") {
      state.recent = [];
      await chrome.storage.session.set({qrState: state});
      const tabs = await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(tab => chrome.action.setBadgeText({tabId: tab.id, text: ""})));
      return {ok: true};
    }
    if (message.action === "qrTestAlert") {
      const record = {id: crypto.randomUUID(), tabId: sender.tab.id, title: "提醒测试", value: "检测到二维码时，你会收到这样的通知。", detectedAt: now};
      state.recent.unshift(record);
      state.recent = state.recent.slice(0, 20);
      await chrome.storage.session.set({qrState: state});
      return {ok: true, warning: await notify(record, config.sound)};
    }

    if (!config.enabled) return {alerts: []};
    const isShared = extensionPage(sender);
    const sourceKey = `${sender.tab.id}:${isShared ? "shared" : sender.frameId}`;
    state.sources[sourceKey] = {
      key: sourceKey, tabId: sender.tab.id, frameId: sender.frameId, title: String(message.title || sender.tab.title || "直播画面").slice(0, 160),
      state: ["monitoring", "waiting", "blocked", "error", "stopped"].includes(message.state) ? message.state : "monitoring",
      detail: String(message.detail || "").slice(0, 300), checkedAt: now
    };
    const alerts = [];
    if (message.action === "qrScan") {
      const values = Array.isArray(message.values) ? message.values : [];
      for (const value of observe(state.gates, sender.tab.id, values, now, config)) {
        const record = {id: crypto.randomUUID(), tabId: sender.tab.id, title: state.sources[sourceKey].title, value, detectedAt: now};
        state.recent.unshift(record);
        alerts.push(record);
      }
      state.recent = state.recent.slice(0, 20);
    }
    // Save before delivering the alert, including across worker suspension.
    await chrome.storage.session.set({qrState: state});
    let warning = "";
    for (let index = 0; index < alerts.length; index++) {
      warning += await notify(alerts[index], config.sound && index === 0);
    }
    return {alerts, warning};
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["qrGetState", "qrGetPreviews", "qrGetPlaybackPurpose", "qrSetSettings", "qrClearHistory", "qrTestAlert", "qrScan", "qrStatus"].includes(message?.action)) return false;
    const privileged = !["qrScan", "qrStatus", "qrGetPlaybackPurpose"].includes(message.action);
    if (!sender.tab || (privileged ? !extensionPage(sender) : !extensionPage(sender) && !videoPage(sender))) {
      sendResponse({error: "二维码监测请求来源无效。"});
      return false;
    }
    const independent = ["qrGetPreviews", "qrGetPlaybackPurpose"].includes(message.action);
    const result = message.action === "qrGetPreviews" ? getPreviews() : message.action === "qrGetPlaybackPurpose" ? getPlaybackPurpose(sender) : queue.then(() => handle(message, sender));
    if (!independent) queue = result.catch(() => {});
    result.then(sendResponse, error => sendResponse({error: error.message}));
    return true;
  });

  chrome.notifications.onClicked.addListener(async id => {
    if (!id.startsWith("sjtu-qr:")) return;
    try {
      const {qrState} = await chrome.storage.session.get("qrState");
      const record = qrState?.recent.find(item => `sjtu-qr:${item.id}` === id);
      if (!record) return;
      const tab = await chrome.tabs.update(record.tabId, {active: true});
      await chrome.windows.update(tab.windowId, {focused: true});
      await chrome.notifications.clear(id);
    } catch { /* Clicking an old notification must not open the QR payload. */ }
  });
  chrome.tabs?.onRemoved?.addListener(tabId => {
    chrome.storage.session.remove(SJTUPlayer.purposeKey(tabId)).catch(() => {});
  });
})();

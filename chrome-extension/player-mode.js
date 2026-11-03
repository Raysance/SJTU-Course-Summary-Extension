/* Modern play-center tabs, verified from AllInOnePlayLink's published render. */
(() => {
  if (globalThis.SJTUPlayer) return;
  function center(doc) {
    const root = doc.querySelector(".all-in-one-play-link");
    if (!root) return null;
    const tabs = [...root.querySelectorAll("header .tab-wrapper .tab-item")];
    const find = label => tabs.find(tab => tab.textContent.replace(/\s+/g, "") === label);
    const liveTab = find("直播"), replayTab = find("点播");
    const mode = liveTab?.classList.contains("active") ? "live" : replayTab?.classList.contains("active") ? "replay" : "waiting";
    return {kind: "center", mode, root, document: doc, liveTab, replayTab};
  }
  function inspect(doc, href, frameWindow) {
    const own = center(doc);
    if (own) return own;
    // An SDK iframe can inherit its same-origin play-center's active mode.
    let current = frameWindow;
    for (let depth = 0; depth < 4 && current; depth++) {
      try {
        if (!current.parent || current.parent === current) break;
        current = current.parent;
        const parent = center(current.document);
        if (parent) return parent;
      } catch { break; }
    }
    let route = "";
    try { route = new URL(href).hash.slice(1).split("?")[0].replace(/\/$/, ""); } catch {}
    if (["/play-live", "/live-share"].includes(route)) return {kind: "live", mode: "live"};
    if (["/play-video", "/video-detail", "/vod-share"].includes(route)) return {kind: "replay", mode: "replay"};
    if (route === "/play-center") return {kind: "center", mode: "waiting", root: null};
    if (doc.querySelector(".live-page-wrapper")) return {kind: "live", mode: "live"};
    if (doc.querySelector(".video-page-wrapper")) return {kind: "replay", mode: "replay"};
    return {kind: "unknown", mode: "waiting"};
  }
  function select(context, mode) {
    if (context.mode === mode) return "ready";
    const tab = mode === "live" ? context.liveTab : context.replayTab;
    if (!tab || tab.getAttribute("aria-disabled") === "true" || tab.classList.contains("disabled")) return "waiting";
    tab.click();
    return "switching";
  }
  const api = {inspect, select, purposeKey: tabId => `sjtuPlaybackPurpose:${tabId}`};
  globalThis.SJTUPlayer = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();

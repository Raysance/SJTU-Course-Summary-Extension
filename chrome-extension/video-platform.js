/* Platform identity and course navigation discovery; no page or browser APIs. */
(() => {
  if (globalThis.SJTUVideo) return;
  const CANVAS_ORIGIN = "https://oc.sjtu.edu.cn";
  const VIDEO_ORIGIN = "https://v.sjtu.edu.cn";
  const MODERN_PATH = "/jy-application-resourcemanage-ui/";
  const LEGACY_PATH = "/jy-application-canvas-sjtu-ui/";
  // The user identified this course tool as the discontinued classroom player.
  const DISCONTINUED_TOOL = "18717";
  const OLD_LABEL = /旧|老版|停用|停止维护|已下线|deprecated|\blegacy\b|\bold\b/i;
  const NEW_LABEL = /新版|新平台|新系统|新版本|更新版|[（(\[【]\s*新\s*[）)\]】]|(?:^|[^a-z])new(?:[^a-z]|$)/i;
  const RECORDING_LABEL = /课堂视频|课程视频|教学视频|录播|录课|课堂录像|课程录像|课堂实录|(?:class|course|lecture).{0,16}(?:video|record)|(?:video|record).{0,16}(?:class|course|lecture)/i;

  function parseUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, CANVAS_ORIGIN);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      return url;
    } catch { return null; }
  }

  function appPath(pathname, prefix) {
    return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix);
  }

  function isModernUrl(value) {
    const url = parseUrl(value);
    return !!url && url.origin === VIDEO_ORIGIN && appPath(url.pathname, MODERN_PATH);
  }

  function isLegacyUrl(value) {
    const url = parseUrl(value);
    return !!url && url.origin === VIDEO_ORIGIN && appPath(url.pathname, LEGACY_PATH);
  }

  function isVideoUrl(value) {
    return isModernUrl(value) || isLegacyUrl(value);
  }

  function numericId(value) {
    const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
    return /^[1-9]\d*$/.test(text) ? text : "";
  }

  function courseIdFromUrl(value) {
    const url = parseUrl(value);
    if (!url || url.origin !== CANVAS_ORIGIN) return "";
    return url.pathname.match(/^\/courses\/([1-9]\d*)(?:\/|$)/)?.[1] || "";
  }

  function canvasLaunch(value, courseId) {
    const url = parseUrl(value);
    if (!url || url.origin !== CANVAS_ORIGIN) return null;
    const match = url.pathname.match(/^\/courses\/([1-9]\d*)\/external_tools\/([1-9]\d*)\/?$/);
    if (!match || match[1] !== courseId || match[2] === DISCONTINUED_TOOL) return null;
    return {url: url.href, toolId: match[2]};
  }

  function labelOf(row) {
    const value = row?.label || row?.name || row?.course_navigation?.text;
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function inCourse(row, courseId) {
    if (row?.course_id != null && numericId(row.course_id) !== courseId) return false;
    // Tool ownership can be Account or Course. A bare/account context_id is
    // not sufficient to identify a different course in inherited metadata.
    // The caller supplies course-scoped API results; launch URLs are checked
    // separately against the requested course in every case.
    const type = typeof row?.context_type === "string" ? row.context_type.toLowerCase() : "";
    return type !== "course" || row.context_id == null || numericId(row.context_id) === courseId;
  }

  function unavailable(row) {
    return !row || typeof row !== "object" || row.hidden === true || row.visibility === "none" ||
      ["deleted", "disabled", "inactive"].includes(row.workflow_state) || OLD_LABEL.test(labelOf(row));
  }

  function tabToolId(row) {
    const match = typeof row?.id === "string" && row.id.match(/^context_external_tool_([1-9]\d*)$/);
    return match ? match[1] : numericId(row?.id);
  }

  function targetAllowed(value, courseId) {
    if (!value) return true;
    const url = parseUrl(value);
    if (!url || isLegacyUrl(value)) return false;
    if (url.origin === VIDEO_ORIGIN) return true;
    return !!canvasLaunch(value, courseId);
  }

  function score(label, modern) {
    if (!modern && !RECORDING_LABEL.test(label)) return 0;
    return (modern ? 1000 : 0) + (NEW_LABEL.test(label) ? 100 : 0) + (RECORDING_LABEL.test(label) ? 20 : 0);
  }

  function chooseCourseEntry(value, {tools = [], tabs = []} = {}) {
    const courseId = numericId(value);
    if (!courseId) return null;
    tools = Array.isArray(tools) ? tools : [];
    tabs = Array.isArray(tabs) ? tabs : [];
    const excluded = new Set([DISCONTINUED_TOOL]);
    const candidates = [];
    const navigation = new Map();

    // Keep negative metadata when looking at tabs alone; an innocuous tab label
    // must not revive a tool whose actual launch URL identifies the old player.
    for (const tool of tools) {
      if (!inCourse(tool, courseId)) continue;
      const id = numericId(tool?.id);
      if (id && (unavailable(tool) || !targetAllowed(tool.url, courseId))) excluded.add(id);
    }
    for (const tab of tabs) {
      if (!inCourse(tab, courseId)) continue;
      const id = tabToolId(tab);
      if (id && unavailable(tab)) excluded.add(id);
    }
    for (const tab of tabs) {
      if (unavailable(tab) || !inCourse(tab, courseId)) continue;
      const href = tab.html_url || tab.url;
      const launch = canvasLaunch(href, courseId);
      const id = tabToolId(tab);
      if (excluded.has(id) || launch && excluded.has(launch.toolId)) continue;
      if (launch && id && id !== launch.toolId) continue;
      if (!launch && !isModernUrl(href)) continue;
      const label = labelOf(tab);
      if (launch) navigation.set(launch.toolId, {url: launch.url, label});
      const rank = score(label, isModernUrl(href));
      if (rank) candidates.push({url: launch?.url || parseUrl(href).href, label: label || "课堂视频", toolId: launch?.toolId || id, rank});
    }
    for (const tool of tools) {
      const id = numericId(tool?.id);
      if (!id || excluded.has(id) || unavailable(tool) || !inCourse(tool, courseId) || !targetAllowed(tool.url, courseId)) continue;
      const nav = navigation.get(id);
      const label = labelOf(tool);
      const rank = score(`${label} ${nav?.label || ""}`, isModernUrl(tool.url));
      if (!rank) continue;
      // Use the institution's actual course launch link. Only synthesize the
      // Canvas wrapper from a numeric ID present in the returned tool metadata.
      candidates.push({url: nav?.url || `${CANVAS_ORIGIN}/courses/${courseId}/external_tools/${id}`, label: nav?.label || label || "课堂视频", toolId: id, rank});
    }
    candidates.sort((a, b) => b.rank - a.rank);
    if (!candidates.length) return null;
    const first = candidates[0];
    const tied = candidates.filter(candidate => candidate.rank === first.rank);
    // Equal evidence for distinct tools is unresolved. Duplicate appearances
    // of one tool in navigation and metadata do not create ambiguity.
    if (tied.some(candidate => candidate.url !== first.url &&
      !(candidate.toolId && first.toolId && candidate.toolId === first.toolId))) return null;
    const {rank, ...entry} = first;
    return entry;
  }

  const api = {isModernUrl, isVideoUrl, courseIdFromUrl, chooseCourseEntry};
  globalThis.SJTUVideo = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();

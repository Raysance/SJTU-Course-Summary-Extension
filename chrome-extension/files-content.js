if (!globalThis.__SJTU_FILE_TOOL_LOADED__) {
globalThis.__SJTU_FILE_TOOL_LOADED__ = true;

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

function reportCaughtError(context, error) {
  const message = `${context}：${errorMessage(error)}`;
  console.error(`[SJTU Course Helper] ${message}`, error);
  return message;
}

function textOf(node) {
  return (node?.textContent || "").replace(/\s+/g, " ").trim();
}

function courseIdFromPage() {
  return location.pathname.match(/\/courses\/(\d+)\/files\b/)?.[1] || "";
}

function cleanFolderName(value) {
  return decodeURIComponent(value || "").split("/").filter(Boolean).pop() || value || "";
}

function scanCanvasFilesPage() {
  const folder = decodeURIComponent(location.pathname.split("/files/folder/")[1] || "");
  const rows = [...document.querySelectorAll(".ef-item-row, [role='row']")]
    .filter(row => !row.classList.contains("ef-directory-header"));
  const files = [];
  const folders = [];
  const seenFiles = new Set();
  const seenFolders = new Set();
  for (const row of rows) {
    const downloadLink = row.querySelector("a[href*='/files/'][href*='/download']");
    if (downloadLink) {
      const id = downloadLink.href.match(/\/files\/(\d+)\/download/)?.[1] || "";
      if (!id || seenFiles.has(id)) continue;
      seenFiles.add(id);
      const name = textOf(downloadLink) || textOf(row.querySelector("[role='rowheader']")) || `文件 ${id}`;
      const cells = [...row.querySelectorAll("[role='gridcell'], .ef-date-created-col, .ef-date-modified-col, .ef-size-col")].map(textOf);
      const size = cells.find(value => /\d(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)$/i.test(value)) || "";
      files.push({
        id,
        name,
        path: [folder, name].filter(Boolean).join("/"),
        sizeText: size,
        downloadUrl: downloadLink.href,
        source: "canvas-dom"
      });
      continue;
    }
    const folderLink = row.querySelector("a[href*='/files/folder/']");
    if (folderLink) {
      const href = folderLink.href;
      if (seenFolders.has(href)) continue;
      seenFolders.add(href);
      folders.push({
        name: textOf(folderLink) || cleanFolderName(new URL(href).pathname),
        href
      });
    }
  }
  return {
    courseId: courseIdFromPage(),
    title: textOf(document.querySelector("nav[aria-label='breadcrumbs'] li:last-child")) || document.title,
    folder,
    files,
    folders
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchCanvasFile(downloadUrl) {
  const url = new URL(downloadUrl, location.href);
  if (url.origin !== location.origin || !/\/files\/\d+\/download\b/.test(url.pathname)) {
    throw new Error("文件下载地址不属于当前 Canvas 站点。");
  }
  const response = await fetch(url.href, {credentials: "include"});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return {
    base64: arrayBufferToBase64(buffer),
    contentType: response.headers.get("content-type") || "",
    size: buffer.byteLength
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scanCanvasFiles") {
    sendResponse(scanCanvasFilesPage());
    return false;
  }
  if (message.action === "fetchCanvasFile") {
    fetchCanvasFile(message.downloadUrl)
      .then(sendResponse)
      .catch(error => sendResponse({error: reportCaughtError("课程文件页读取 Canvas 文件失败", error)}));
    return true;
  }
  return false;
});
}

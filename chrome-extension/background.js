chrome.action.onClicked.addListener(async () => {
  const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  const courseId = activeTab?.url?.match(/^https:\/\/oc\.sjtu\.edu\.cn\/courses\/(\d+)\/files\b/)?.[1] || "";
  const url = chrome.runtime.getURL(`app.html${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`);
  const existing = await chrome.tabs.query({url: chrome.runtime.getURL("app.html*")});
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, {active: true, url});
    await chrome.windows.update(existing[0].windowId, {focused: true});
    return;
  }
  await chrome.tabs.create({url});
});

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

function reportCaughtError(context, error) {
  const message = `${context}：${errorMessage(error)}`;
  console.error(`[SJTU Course Helper] ${message}`, error);
  return message;
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
  const url = new URL(downloadUrl);
  if (url.origin !== "https://oc.sjtu.edu.cn" || !/\/files\/\d+\/download\b/.test(url.pathname)) {
    throw new Error("文件下载地址不属于 oc.sjtu.edu.cn。");
  }

  const finalUrl = await resolveCanvasDownloadUrl(url.href);

  const target = new URL(finalUrl);
  const response = await fetch(target.href, {
    credentials: target.origin === "https://oc.sjtu.edu.cn" ? "include" : "omit",
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return responseToPayload(response, target);
}

function resolveCanvasDownloadUrl(downloadUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(null, new Error("未捕获到 Canvas 文件跳转地址。")), 12000);
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        chrome.webRequest.onBeforeRedirect.removeListener(listener);
      } catch (error) {
        reportCaughtError("移除 Canvas 文件跳转监听失败", error);
      }
      if (error) reject(error);
      else resolve(value);
    };
    const listener = details => {
      if (details.url === downloadUrl && details.redirectUrl) {
        finish(details.redirectUrl);
      }
    };
    chrome.webRequest.onBeforeRedirect.addListener(listener, {
      urls: ["https://oc.sjtu.edu.cn/files/*/download*"]
    });
    fetch(downloadUrl, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store"
    }).then(response => {
      if (response.ok && response.url === downloadUrl) finish(downloadUrl);
    }).catch(error => {
      reportCaughtError("后台解析 Canvas 文件跳转时 fetch 失败", error);
    });
  });
}

async function responseToPayload(response, url) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html") && !url.pathname.endsWith(".html")) {
    const preview = (await response.clone().text()).slice(0, 400).toLowerCase();
    if (preview.includes("<!doctype html") || preview.includes("<html")) {
      throw new Error("下载端点返回了网页内容，可能登录态未带入或下载被重定向拦截。");
    }
  }
  const buffer = await response.arrayBuffer();
  return {
    base64: arrayBufferToBase64(buffer),
    contentType,
    size: buffer.byteLength
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "fetchCanvasFileInBackground") return false;
  fetchCanvasFile(message.downloadUrl)
    .then(sendResponse)
    .catch(error => sendResponse({error: reportCaughtError("后台读取 Canvas 文件失败", error)}));
  return true;
});

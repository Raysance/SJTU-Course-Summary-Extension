const {test, expect, chromium} = require("@playwright/test");
const path = require("node:path");
const QRCode = require("qrcode");
const extension = path.resolve(__dirname, "../../chrome-extension");
const liveUrl = "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui/qr-test";
let context, worker, id, panel;

const liveHtml = `<!doctype html><meta charset="utf-8"><title>模拟课堂直播</title>
<div class="all-in-one-play-link"><header><h1>模拟课堂直播</h1><div class="tab-wrapper"><div class="tab-item">点播</div><div class="tab-item active">直播</div></div></header><div class="live-page-wrapper"><video autoplay muted playsinline style="width:960px"></video></div></div>
<script>
const canvas = document.createElement('canvas'); canvas.width=1280; canvas.height=720;
const ctx=canvas.getContext('2d');
function blank(){ctx.fillStyle='#f5f5f5';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#345';ctx.font='36px sans-serif';ctx.fillText('Lecture live stream',90,100);}
blank(); const stream=canvas.captureStream(5); document.querySelector('video').srcObject=stream;
setInterval(()=>stream.getVideoTracks()[0].requestFrame?.(),200);
window.drawQR=async url=>{blank();const img=new Image();img.src=url;await img.decode();ctx.drawImage(img,850,250,280,280);stream.getVideoTracks()[0].requestFrame?.();};
window.clearQR=blank;
</script>`;

async function state() { return panel.evaluate(() => chrome.runtime.sendMessage({action: "qrGetState"})); }
async function configure(settings) {
  const reply = await panel.evaluate(settings => chrome.runtime.sendMessage({action: "qrSetSettings", settings}), settings);
  expect(reply.error).toBeUndefined();
}

test.beforeEach(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, viewport: {width: 1280, height: 1000},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  id = worker.url().split("/")[2];
  await context.route("https://v.sjtu.edu.cn/**", route => route.fulfill({contentType: "text/html", body: liveHtml}));
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/qr-monitor.html`);
  await expect(panel.locator("#share-start")).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.log("Failure state:", JSON.stringify(await state().catch(() => ({}))));
  await context?.close();
});

test("live pixels decode, duplicate frames stay quiet, new codes alert and disabling stops work", async () => {
  const page = await context.newPage();
  await page.goto(liveUrl);
  await configure({enabled: true, sound: false, intervalMs: 750});
  await expect.poll(async () => (await state()).sources.some(source => source.state === "monitoring")).toBe(true);
  expect((await state()).recent).toHaveLength(0);
  const first = "https://example.com/checkin?course=SJTU";
  await page.evaluate(data => window.drawQR(data), await QRCode.toDataURL(first, {width: 280}));
  await expect.poll(async () => (await state()).recent.map(record => record.value)).toEqual([first]);
  await expect.poll(async () => (await state()).sources[0].detail).toContain("ms");
  // Several complete scans must preserve a single alert.
  const detectedAt = (await state()).recent[0].detectedAt;
  await expect.poll(async () => (await state()).sources[0].checkedAt - detectedAt, {timeout: 10000}).toBeGreaterThan(2500);
  expect((await state()).recent).toHaveLength(1);
  await page.evaluate(data => window.drawQR(data), await QRCode.toDataURL("second-code", {width: 280}));
  await expect.poll(async () => (await state()).recent[0]?.value).toBe("second-code");
  await configure({enabled: false});
  await page.evaluate(data => window.drawQR(data), await QRCode.toDataURL("after-stop", {width: 280}));
  expect((await state()).settings.enabled).toBe(false);
  expect((await state()).recent).toHaveLength(2);
  const notifications = await worker.evaluate(() => chrome.notifications.getAll());
  expect(Object.keys(notifications).length).toBe(2);
  // Content-scanner pixels are bounded even though the stream is 1280 px wide.
  console.log("Scan status:", (await state()).recent.length, "alerts; native notification delivery verified.");
});

test("shared capture uses the same real decoder and releases tracks when disabled", async () => {
  await panel.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1280, 720);
      const stream = canvas.captureStream(5);
      window.testCapture = {canvas, stream};
      return stream;
    };
  });
  await panel.locator("#share-start").click();
  await expect(panel.locator("#share-status")).toContainText("正在监测这段直播");
  const value = "<img src=x onerror=alert(1)>";
  await panel.evaluate(async data => {
    const img = new Image(); img.src = data; await img.decode();
    window.testCapture.canvas.getContext("2d").drawImage(img, 100, 100, 280, 280);
  }, await QRCode.toDataURL(value, {width: 280}));
  await expect.poll(async () => (await state()).recent[0]?.value).toBe(value);
  await panel.locator("#qr-history-panel summary").click();
  await expect(panel.locator("#qr-history")).toContainText(value);
  expect(await panel.locator("#qr-history img").count()).toBe(0);
  await configure({enabled: false});
  await expect.poll(() => panel.evaluate(() => window.testCapture.stream.getTracks()[0].readyState)).toBe("ended");
  await expect(panel.locator("#share-video")).toBeHidden();
  await expect(panel.locator("#share-start")).toBeEnabled();
});

test("sharing cancellation stays idle and monitoring can restart after a manual stop", async () => {
  await panel.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException("Cancelled", "NotAllowedError"); };
  });
  await panel.locator("#share-start").click();
  await expect(panel.locator("#qr-feedback")).toContainText("尚未选择直播画面");
  await expect(panel.locator("#share-start")).toBeEnabled();
  expect((await state()).settings.enabled).toBe(false);
  await panel.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      canvas.getContext("2d").fillRect(0, 0, 640, 360);
      return canvas.captureStream(2);
    };
  });
  for (let index = 0; index < 2; index++) {
    await panel.locator("#share-start").click();
    await expect(panel.locator("#share-status")).toContainText("正在监测这段直播");
    await panel.locator("#share-stop").click();
    await expect(panel.locator("#qr-feedback")).toContainText("已停止共享");
  }
});

test("a real QR alert creates a notification and offscreen audio without a test button", async () => {
  await panel.evaluate(data => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 640, 360);
      const img = new Image(); img.src = data; await img.decode(); ctx.drawImage(img, 100, 60, 220, 220);
      return canvas.captureStream(2);
    };
  }, await QRCode.toDataURL("notification-and-sound", {width: 220}));
  await panel.locator("#share-start").click();
  await expect.poll(async () => (await state()).recent.length).toBe(1);
  await expect.poll(() => worker.evaluate(async () => (await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]})).length)).toBe(1);
  expect((await state()).recent[0].value).toBe("notification-and-sound");
  expect(Object.keys(await worker.evaluate(() => chrome.notifications.getAll()))).toHaveLength(1);
  await panel.evaluate(() => chrome.runtime.sendMessage({action: "qrClearHistory"}));
  await expect.poll(async () => (await state()).recent.length).toBe(0);
});

test("main app renders the new panel alongside existing course features", async () => {
  await context.route("https://oc.sjtu.edu.cn/**", route => route.fulfill({contentType: "application/json", body: "[]"}));
  await panel.goto(`chrome-extension://${id}/app.html`);
  await expect(panel.locator("#qr-title")).toHaveText("二维码提醒");
  await expect(panel.locator(".files-card")).toBeVisible();
  await expect(panel.locator(".video-card")).toBeVisible();
  await expect(panel.locator(".qr-card input:visible")).toHaveCount(1);
  await expect(panel.locator(".qr-card select")).toHaveCount(0);
  await expect(panel.locator(".qr-card button:visible")).toHaveCount(0);
  await expect(panel.locator(".qr-card")).not.toContainText(/jsQR|960|API|检查间隔|毫秒/);
  await expect(panel.locator("#qr-history-panel")).toBeHidden();
  await panel.locator("#qr-enabled").check();
  await expect.poll(async () => (await state()).settings.enabled).toBe(true);
  await expect(panel.locator("#qr-sources")).toContainText("已开启");
  await expect(panel.locator("#share-start")).toBeHidden();
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.locator(".qr-card").screenshot({path: path.resolve(__dirname, "../../test-results/qr-feature-preview.png")});
  await panel.setViewportSize({width: 375, height: 900});
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.locator("#qr-enabled").uncheck();
  await expect(panel.locator("#qr-sources")).toContainText("提醒已关闭");
});

test("bundled fallback decodes with native support disabled under 4x CPU throttling", async () => {
  const data = await QRCode.toDataURL("fallback-on-slower-device", {width: 320});
  await configure({sound: false, intervalMs: 3000});
  await panel.evaluate(data => {
    globalThis.BarcodeDetector = undefined;
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1920, 1080);
      const img = new Image(); img.src = data; await img.decode(); ctx.drawImage(img, 200, 200, 420, 420);
      return canvas.captureStream(2);
    };
  }, data);
  const cdp = await context.newCDPSession(panel);
  await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4});
  await panel.locator("#share-start").click();
  await expect.poll(async () => (await state()).recent[0]?.value, {timeout: 25000}).toBe("fallback-on-slower-device");
  await expect.poll(async () => (await state()).sources[0]?.detail).toContain("jsQR");
  await expect(panel.locator("#share-status")).not.toContainText(/jsQR|ms|960/);
  console.log("4x CPU fallback:", (await state()).sources[0].detail);
  await panel.locator("#share-stop").click();
});

test("cross-origin video reports a capture fallback instead of repeatedly decoding a tainted canvas", async () => {
  const page = await context.newPage();
  await page.goto(liveUrl);
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 320, 240);
    const stream = canvas.captureStream(5);
    const recorder = new MediaRecorder(stream, {mimeType: "video/webm;codecs=vp8"});
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const ended = new Promise(resolve => recorder.onstop = resolve);
    recorder.start();
    let frame = 0;
    const frames = setInterval(() => {
      ctx.fillStyle = ++frame % 2 ? "black" : "white";
      ctx.fillRect(0, 0, 40, 40);
      stream.getVideoTracks()[0].requestFrame?.();
    }, 100);
    await new Promise(resolve => setTimeout(resolve, 1000));
    clearInterval(frames);
    recorder.stop(); await ended; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  await context.route("https://s3.jcloud.sjtu.edu.cn/test-live.webm", route => route.fulfill({contentType: "video/webm", body: Buffer.from(bytes)}));
  await page.evaluate(() => {
    const video = document.querySelector("video");
    video.srcObject = null; video.src = "https://s3.jcloud.sjtu.edu.cn/test-live.webm"; video.loop = true;
    return video.play();
  });
  await expect.poll(() => page.evaluate(() => {
    const video = document.querySelector("video");
    return video.readyState >= 2 && video.videoWidth === 320 && !video.paused && !video.ended;
  })).toBe(true);
  await configure({enabled: true, sound: false, intervalMs: 750});
  await expect.poll(async () => (await state()).sources.some(source => source.state === "blocked")).toBe(true);
  await context.route("https://oc.sjtu.edu.cn/**", route => route.fulfill({contentType: "application/json", body: "[]"}));
  await panel.goto(`chrome-extension://${id}/app.html`);
  await expect(panel.locator("#qr-sources")).toContainText("这段直播需要你选择一次画面");
  await expect(panel.locator("#share-start")).toBeVisible();
  await panel.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      canvas.getContext("2d").fillRect(0, 0, 640, 360);
      window.appCaptureStream = canvas.captureStream(2);
      return window.appCaptureStream;
    };
  });
  const tabsBefore = context.pages().length;
  await panel.locator("#share-start").click();
  await expect(panel.locator("#share-status")).toContainText("正在监测这段直播");
  expect(context.pages().length).toBe(tabsBefore);
  await panel.locator("#qr-enabled").uncheck();
  await expect.poll(() => panel.evaluate(() => window.appCaptureStream.getVideoTracks()[0].readyState)).toBe("ended");
  await expect(panel.locator("#qr-sources")).toContainText("提醒已关闭");
  expect((await state()).recent).toHaveLength(0);
});

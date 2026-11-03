const {test} = require("node:test");
const assert = require("node:assert/strict");
const {settings, observe, safeHttpUrl, Scanner} = require("../chrome-extension/qr-core.js");
const jsQR = require("../chrome-extension/vendor/jsQR.js");
const QRCode = require("qrcode");

test("settings validate bounds and default to low-frequency opt-in monitoring", () => {
  assert.deepEqual(settings(), {enabled: false, sound: true, intervalMs: 1500, cooldownMs: 60000});
  assert.deepEqual(settings({enabled: "yes", intervalMs: 0, cooldownMs: 1, sound: false}), {enabled: false, sound: false, intervalMs: 1500, cooldownMs: 60000});
  assert.equal(settings({intervalMs: 3000}).intervalMs, 3000);
});

test("one continuous QR is never repeated, even after cooldown or worker-state restoration", () => {
  let entries = [];
  const config = settings();
  assert.deepEqual(observe(entries, 1, ["A", "A"], 100000, config), ["A"]);
  for (let now = 101000; now <= 300000; now += 1000) {
    entries = JSON.parse(JSON.stringify(entries));
    assert.deepEqual(observe(entries, 1, ["A"], now, config), []);
  }
});

test("reappearing QR requires both absence and cooldown, while new QR alerts immediately", () => {
  const entries = [];
  const config = settings();
  observe(entries, 1, ["A"], 100000, config);
  assert.deepEqual(observe(entries, 1, [], 115000, config), []);
  assert.deepEqual(observe(entries, 1, ["A"], 120000, config), []);
  assert.deepEqual(observe(entries, 1, ["B"], 120001, config), ["B"]);
  assert.deepEqual(observe(entries, 1, ["A"], 160001, config), ["A"]);
});

test("multiple frames of one tab deduplicate, independent tabs still alert", () => {
  const entries = [];
  observe(entries, 1, ["A"], 100000, settings());
  assert.deepEqual(observe(entries, 1, ["A"], 100001, settings()), []);
  assert.deepEqual(observe(entries, 2, ["A"], 100001, settings()), ["A"]);
});

test("untrusted values are bounded and URL actions exclude executable payloads", () => {
  const entries = [];
  assert.deepEqual(observe(entries, 1, [null, {}, "", "x".repeat(8193), "__proto__"], 1, settings()), ["__proto__"]);
  for (let now = 2; now < 240; now++) observe(entries, 1, [String(now)], now, settings());
  assert.equal(entries.length, 200);
  for (const value of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/hosts", "<img src=x onerror=alert(1)>"]) {
    assert.equal(safeHttpUrl(value), "");
  }
  assert.equal(safeHttpUrl("https://example.com/attendance?a=1"), "https://example.com/attendance?a=1");
});

test("adaptive delay does not exceed the selected scan rate or accumulate a queue", () => {
  assert.equal(Scanner.prototype.delay.call({durationMs: 25}, settings()), 1500);
  assert.equal(Scanner.prototype.delay.call({durationMs: 450}, settings()), 4500);
  assert.equal(Scanner.prototype.delay.call({durationMs: 1500}, settings()), 8000);
});

test("native QR decoding bypasses jsQR and limits sampled pixels to 960 px", async () => {
  const previous = {document: global.document, BarcodeDetector: global.BarcodeDetector, jsQR: global.jsQR};
  const canvas = {width: 0, height: 0, getContext: () => ({drawImage() {}, getImageData() { throw new Error("native path must not copy pixels"); }})};
  global.document = {createElement: () => canvas};
  global.BarcodeDetector = class {
    static async getSupportedFormats() { return ["qr_code"]; }
    async detect() { return [{rawValue: "native-result"}]; }
  };
  global.jsQR = () => { throw new Error("native path must not run jsQR"); };
  try {
    const scanner = new Scanner();
    assert.deepEqual(await scanner.scan({readyState: 2, videoWidth: 3840, videoHeight: 2160}), ["native-result"]);
    assert.equal(canvas.width, 960);
    assert.equal(canvas.height, 540);
    scanner.release();
    assert.equal(canvas.width, 1);
  } finally { Object.assign(global, previous); }
});

test("bundled jsQR decodes real QR pixels and ignores a blank frame", () => {
  const value = "https://example.com/attendance?id=SJTU-2026";
  const code = QRCode.create(value, {errorCorrectionLevel: "M"});
  const scale = 5;
  const width = (code.modules.size + 8) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const qx = Math.floor(x / scale) - 4;
      const qy = Math.floor(y / scale) - 4;
      if (qx >= 0 && qy >= 0 && qx < code.modules.size && qy < code.modules.size && code.modules.get(qy, qx)) {
        const index = (y * width + x) * 4;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
      }
    }
  }
  assert.equal(jsQR(pixels, width, width, {inversionAttempts: "dontInvert"}).data, value);
  assert.equal(jsQR(new Uint8ClampedArray(width * width * 4).fill(255), width, width), null);
});

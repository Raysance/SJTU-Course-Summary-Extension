/* Shared by the isolated content script, extension page and service worker. */
(() => {
  if (globalThis.SJTUQR) return;
  const DEFAULTS = Object.freeze({enabled: false, sound: true, intervalMs: 1500, cooldownMs: 60000});

  function settings(value = {}) {
    return {
      enabled: value.enabled === true,
      sound: value.sound !== false,
      intervalMs: [750, 1500, 3000].includes(value.intervalMs) ? value.intervalMs : DEFAULTS.intervalMs,
      cooldownMs: [30000, 60000, 300000].includes(value.cooldownMs) ? value.cooldownMs : DEFAULTS.cooldownMs
    };
  }

  // Only a disappearance followed by a new appearance can repeat an alert.
  // Keep the gate in storage.session so service-worker suspension preserves it.
  function observe(entries, scope, values, now, config) {
    const alerts = [];
    const unique = [...new Set(values.filter(value => typeof value === "string" && value.length > 0 && value.length <= 8192))].slice(0, 5);
    for (const value of unique) {
      let entry = entries.find(item => item.scope === scope && item.value === value);
      if (!entry) {
        entry = {scope, value, lastSeen: now, lastAlert: now};
        entries.push(entry);
        alerts.push(value);
      } else {
        if (now - entry.lastSeen >= Math.max(10000, config.intervalMs * 4) && now - entry.lastAlert >= config.cooldownMs) {
          entry.lastAlert = now;
          alerts.push(value);
        }
        entry.lastSeen = now;
      }
    }
    entries.sort((a, b) => b.lastSeen - a.lastSeen);
    entries.splice(200);
    return alerts;
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  class Scanner {
    constructor() {
      this.canvas = document.createElement("canvas");
      this.context = this.canvas.getContext("2d", {willReadFrequently: true});
      this.detector = null;
      this.engine = "jsQR";
      this.count = 0;
      this.durationMs = 0;
      this.initialized = false;
    }

    async init() {
      if (this.initialized) return;
      this.initialized = true;
      if (typeof BarcodeDetector !== "function") return;
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
          this.detector = new BarcodeDetector({formats: ["qr_code"]});
          this.engine = "浏览器原生";
        }
      } catch { /* The bundled decoder also works where native QR decoding is unavailable. */ }
    }

    async scan(video) {
      await this.init();
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return [];
      const start = performance.now();
      // At most 960 px on the longest edge, one decode per tick, no full-HD loop.
      const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.context.drawImage(video, 0, 0, width, height);
      try {
        if (this.detector) {
          try {
            return (await this.detector.detect(this.canvas)).map(item => item.rawValue).filter(Boolean);
          } catch (error) {
            if (error.name === "SecurityError") throw error;
            this.detector = null;
            this.engine = "jsQR";
          }
        }
        const pixels = this.context.getImageData(0, 0, width, height);
        // Most frames need only the standard polarity. Occasionally check inverted codes.
        const inversionAttempts = ++this.count % 4 === 0 ? "attemptBoth" : "dontInvert";
        const code = globalThis.jsQR(pixels.data, width, height, {inversionAttempts});
        return code?.data ? [code.data] : [];
      } finally {
        this.durationMs = Math.round(performance.now() - start);
      }
    }

    delay(config) {
      // Back off on slower hardware rather than queueing scans or overlapping work.
      return Math.max(config.intervalMs, Math.min(8000, this.durationMs * 10));
    }

    release() {
      this.canvas.width = this.canvas.height = 1;
      this.detector = null;
    }
  }

  globalThis.SJTUQR = {DEFAULTS, settings, observe, safeHttpUrl, Scanner};
  if (typeof module === "object") module.exports = globalThis.SJTUQR;
})();

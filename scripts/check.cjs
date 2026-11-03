const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const root = path.resolve(__dirname, "../chrome-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
for (const file of fs.readdirSync(root).filter(name => name.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], {stdio: "inherit"});
}
for (const file of [manifest.background.service_worker, ...manifest.content_scripts.flatMap(item => item.js), "assets/qr-notification.png", "assets/qr-alert.wav", "qr-audio.html"]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing extension file: ${file}`);
}
if (manifest.version !== fs.readFileSync(path.resolve(__dirname, "../VERSION"), "utf8").trim()) throw new Error("VERSION mismatch");
console.log("JavaScript syntax, extension resources and version are valid.");

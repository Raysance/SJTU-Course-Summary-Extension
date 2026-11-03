const {test} = require("node:test");
const assert = require("node:assert/strict");
const {parseHTML} = require("linkedom");
const player = require("../chrome-extension/player-mode.js");
const url = "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui/#/play-center?encrypted-query";
const markup = '<div class="all-in-one-play-link"><header><div class="tab-wrapper"><div id="vod" class="tab-item active">点播</div><div id="live" class="tab-item">直播</div></div></header></div>';

test("play-center mode is read from the real active tab, independent of opaque routing parameters", () => {
  const {document} = parseHTML(markup);
  const context = player.inspect(document, url);
  assert.equal(context.mode, "replay");
  let clicked = 0;
  document.getElementById("live").click = () => { ++clicked; };
  assert.equal(player.select(context, "live"), "switching");
  assert.equal(clicked, 1);
  assert.equal(url.endsWith("?encrypted-query"), true);
});

test("unavailable live tabs do not click an unrelated control", () => {
  const {document} = parseHTML(markup.replace('<div id="live" class="tab-item">直播</div>', '<div class="tab-item">消息</div>'));
  assert.equal(player.select(player.inspect(document, url), "live"), "waiting");
  const disabled = parseHTML(markup).document;
  disabled.getElementById("live").setAttribute("aria-disabled", "true");
  disabled.getElementById("live").click = () => { throw new Error("must not click"); };
  assert.equal(player.select(player.inspect(disabled, url), "live"), "waiting");
});

test("SDK frames follow their same-origin parent and safely stop at an inaccessible parent", () => {
  const parent = parseHTML(markup.replace('class="tab-item active">点播', 'class="tab-item">点播').replace('id="live" class="tab-item"', 'id="live" class="tab-item active"')).document;
  const child = parseHTML('<video></video>').document;
  const top = {document: parent}; top.parent = top;
  const iframe = {parent: top};
  assert.equal(player.inspect(child, "https://v.sjtu.edu.cn/player", iframe).mode, "live");
  const blocked = {}; Object.defineProperty(blocked, "document", {get() { throw new Error("cross origin"); }});
  assert.equal(player.inspect(child, "https://v.sjtu.edu.cn/player", {parent: blocked}).mode, "waiting");
});

test("explicit live and replay routes are distinguished without modifying their URLs", () => {
  const {document} = parseHTML('<div></div>');
  for (const route of ["play-live", "live-share"]) assert.equal(player.inspect(document, url.replace("play-center", route)).mode, "live");
  for (const route of ["play-video", "video-detail", "vod-share"]) assert.equal(player.inspect(document, url.replace("play-center", route)).mode, "replay");
  assert.equal(player.inspect(document, url).mode, "waiting");
});

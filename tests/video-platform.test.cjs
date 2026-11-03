const {test} = require("node:test");
const assert = require("node:assert/strict");
const {isModernUrl, isVideoUrl, courseIdFromUrl, chooseCourseEntry} = require("../chrome-extension/video-platform.js");
const modern = "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui/#/play-center?course-context";
const legacy = "https://v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/#/play";
const courseId = "94306";
const launch = id => `https://oc.sjtu.edu.cn/courses/${courseId}/external_tools/${id}`;
const tab = (id, label, extra = {}) => ({id: `context_external_tool_${id}`, label, html_url: `/courses/${courseId}/external_tools/${id}`, ...extra});

test("platform identity checks exact HTTPS origin and path boundaries", () => {
  assert.equal(isModernUrl(modern), true);
  assert.equal(isModernUrl("https://v.sjtu.edu.cn/jy-application-resourcemanage-ui"), true);
  assert.equal(isVideoUrl(legacy), true);
  assert.equal(isModernUrl(legacy), false);
  for (const value of [
    "http://v.sjtu.edu.cn/jy-application-resourcemanage-ui/",
    "https://v.sjtu.edu.cn.evil.example/jy-application-resourcemanage-ui/",
    "https://evil.example/v.sjtu.edu.cn/jy-application-resourcemanage-ui/",
    "https://v.sjtu.edu.cn/jy-application-resourcemanage-ui-other/",
    "https://v.sjtu.edu.cn:8443/jy-application-resourcemanage-ui/",
    "https://user:secret@v.sjtu.edu.cn/jy-application-resourcemanage-ui/",
    null
  ]) assert.equal(isModernUrl(value), false, String(value));
});

test("course IDs come only from trusted Canvas course URLs", () => {
  assert.equal(courseIdFromUrl(launch("501")), courseId);
  assert.equal(courseIdFromUrl(`/courses/${courseId}/files`), courseId);
  assert.equal(courseIdFromUrl(`https://oc.sjtu.edu.cn/courses/${courseId}`), courseId);
  for (const value of [modern, "https://oc.sjtu.edu.cn.evil.example/courses/94306/files", "/courses/94306bad/files", "/courses/0/files", "javascript:alert(1)"]) {
    assert.equal(courseIdFromUrl(value), "");
  }
});

test("verified modern tool metadata uses its actual same-course navigation link", () => {
  const entry = chooseCourseEntry(courseId, {
    tools: [{id: 502, name: "课程视频", url: modern, context_id: Number(courseId)}],
    tabs: [tab(502, "课堂视频（新版）", {html_url: `/courses/${courseId}/external_tools/502?display=borderless`})]
  });
  assert.deepEqual(entry, {url: launch("502") + "?display=borderless", label: "课堂视频（新版）", toolId: "502"});
});

test("verified modern target outranks label-only new and generic entries", () => {
  const entry = chooseCourseEntry(courseId, {
    tools: [
      {id: 501, name: "课堂视频（新版）", url: "https://v.sjtu.edu.cn/lti/launch"},
      {id: 502, name: "课程录像", url: modern}
    ],
    tabs: [tab(500, "课堂视频"), tab(501, "课堂视频 new"), tab(502, "课程录像")]
  });
  assert.deepEqual(entry, {url: launch("502"), label: "课程录像", toolId: "502"});
});

test("navigation-only discovery prioritizes an actual new entry over a generic recording", () => {
  const entry = chooseCourseEntry(courseId, {tabs: [tab(500, "课堂视频"), tab(503, "课堂视频new")]});
  assert.deepEqual(entry, {url: launch("503"), label: "课堂视频new", toolId: "503"});
  assert.equal(chooseCourseEntry(courseId, {tabs: [tab(504, "课堂视频（新）")]}).toolId, "504");
});

test("explicit discontinued tools and legacy metadata never revive through generic tab labels", () => {
  assert.equal(chooseCourseEntry(courseId, {
    tools: [{id: 501, name: "课堂视频new", url: legacy}],
    tabs: [tab(501, "课堂视频")]
  }), null);
  for (const label of ["课堂视频旧版", "课堂视频（停止维护）", "Lecture recordings (legacy)", "Course video deprecated"]) {
    assert.equal(chooseCourseEntry(courseId, {tools: [{id: 501, name: label, url: modern}], tabs: [tab(501, "课堂视频")]}), null);
  }
  assert.equal(chooseCourseEntry(courseId, {tools: [{id: 18717, name: "课堂视频新版", url: modern}], tabs: [tab(18717, "课堂视频新版")]}), null);
});

test("missing or malformed metadata cannot fabricate a launch tool ID", () => {
  assert.equal(chooseCourseEntry(courseId, {}), null);
  assert.equal(chooseCourseEntry(courseId, {tools: [{id: "not-numeric", name: "课堂视频新版", url: modern}]}), null);
  assert.equal(chooseCourseEntry(courseId, {tools: [{name: "课堂视频新版", url: modern}]}), null);
  assert.equal(chooseCourseEntry("invalid-course", {tabs: [tab(501, "课堂视频新版")]}), null);
  assert.equal(chooseCourseEntry(courseId, {tools: null, tabs: {}}), null);
});

test("cross-course and untrusted launch URLs cannot be selected", () => {
  for (const html_url of [
    "/courses/99999/external_tools/501",
    "https://oc.sjtu.edu.cn.evil.example/courses/94306/external_tools/501",
    "http://oc.sjtu.edu.cn/courses/94306/external_tools/501",
    "javascript:alert(1)",
    "https://evil.example/jy-application-resourcemanage-ui/"
  ]) assert.equal(chooseCourseEntry(courseId, {tabs: [tab(501, "课堂视频新版", {html_url})]}), null);
  assert.equal(chooseCourseEntry(courseId, {tools: [{id: 501, name: "课堂视频新版", url: modern, context_type: "Course", context_id: 99999}]}), null);
  assert.equal(chooseCourseEntry(courseId, {tools: [{id: 501, name: "课堂视频新版", url: "https://evil.example/launch"}], tabs: [tab(501, "课堂视频新版")]}), null);
  assert.equal(chooseCourseEntry(courseId, {tabs: [tab(501, "课堂视频新版", {html_url: `/courses/${courseId}/external_tools/999`})]}), null);
});

test("visible actual tool metadata can supply a launch ID without a tabs API response", () => {
  assert.deepEqual(chooseCourseEntry(Number(courseId), {
    tools: [{id: "507", name: "课程录像", url: modern, context_id: courseId}]
  }), {url: launch("507"), label: "课程录像", toolId: "507"});
  assert.deepEqual(chooseCourseEntry(courseId, {
    tools: [{id: 508, course_navigation: {text: "课堂视频新版"}}]
  }), {url: launch("508"), label: "课堂视频新版", toolId: "508"});
});

test("hidden and disabled entries are excluded; a real modern direct navigation link is retained", () => {
  assert.equal(chooseCourseEntry(courseId, {tabs: [tab(501, "课堂视频新版", {hidden: true})]}), null);
  assert.equal(chooseCourseEntry(courseId, {tools: [{id: 501, name: "课堂视频新版", url: modern, workflow_state: "disabled"}]}), null);
  assert.deepEqual(chooseCourseEntry(courseId, {tabs: [{id: "nav_menu_link_10", label: "课堂视频", html_url: modern}]}), {
    url: modern, label: "课堂视频", toolId: ""
  });
});

test("inherited account and untyped owner contexts do not masquerade as different courses", () => {
  for (const owner of [{context_type: "Account", context_id: 1}, {context_id: 1}]) {
    assert.deepEqual(chooseCourseEntry(courseId, {
      tools: [{id: 510, name: "课堂视频", url: modern, ...owner}],
      tabs: [tab(510, "课堂视频新版")]
    }), {url: launch("510"), label: "课堂视频新版", toolId: "510"});
  }
});

test("explicit course scope remains binding even when tool ownership is an account", () => {
  assert.equal(chooseCourseEntry(courseId, {
    tools: [{id: 510, name: "课堂视频新版", url: modern, context_type: "Account", context_id: 1, course_id: 99999}]
  }), null);
  assert.equal(chooseCourseEntry(courseId, {
    tools: [{id: 510, name: "课堂视频新版", url: modern, context_type: "course", context_id: 99999, course_id: courseId}]
  }), null);
  assert.equal(chooseCourseEntry(courseId, {
    tools: [{id: 510, name: "课堂视频新版", url: "/courses/99999/external_tools/510", context_type: "Account", context_id: 1}]
  }), null);
  assert.equal(chooseCourseEntry(courseId, {
    tabs: [tab(510, "课堂视频新版", {context_type: "Account", context_id: 1, html_url: "/courses/99999/external_tools/510"})]
  }), null);
});

test("equally ranked generic recording tools remain ambiguous rather than taking the first", () => {
  for (const tabs of [[tab(510, "课堂视频"), tab(511, "课程录像")], [tab(511, "课程录像"), tab(510, "课堂视频")]]) {
    assert.equal(chooseCourseEntry(courseId, {tabs}), null);
  }
  assert.equal(chooseCourseEntry(courseId, {
    tools: [{id: 510, name: "课堂视频"}, {id: 511, name: "课堂视频"}],
    tabs: [tab(510, "课堂视频"), tab(511, "课堂视频")]
  }), null);
});

test("duplicate evidence for the same tool or actual navigation URL is not ambiguous", () => {
  assert.deepEqual(chooseCourseEntry(courseId, {
    tools: [{id: 510, name: "课堂视频"}],
    tabs: [tab(510, "课堂视频"), tab(510, "课堂视频", {html_url: `/courses/${courseId}/external_tools/510?display=borderless`})]
  }), {url: launch("510"), label: "课堂视频", toolId: "510"});
  assert.deepEqual(chooseCourseEntry(courseId, {tabs: [
    {id: "nav_menu_link_1", label: "课堂视频", html_url: modern},
    {id: "nav_menu_link_2", label: "课堂视频", html_url: modern}
  ]}), {url: modern, label: "课堂视频", toolId: ""});
});

test("distinct equally strong new entries are also unresolved", () => {
  assert.equal(chooseCourseEntry(courseId, {tabs: [tab(510, "课堂视频新版"), tab(511, "课堂视频new")]}), null);
});

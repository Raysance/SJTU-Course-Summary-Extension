const {defineConfig} = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/browser", timeout: 60000, expect: {timeout: 15000}, workers: 1, reporter: "list",
  outputDir: "test-results"
});

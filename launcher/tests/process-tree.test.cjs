const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("zombie processes cannot own a launcher runtime while stopped processes still can", () => {
  let status = "Z";
  const context = {
    module: { exports: {} },
    process: { platform: "darwin", kill() {} },
    require(name) {
      return name === "node:child_process"
        ? { spawnSync: () => ({ status: 0, stdout: status }) }
        : require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../electron/process-tree.cjs"), "utf8"), context);
  assert.equal(context.module.exports.processRunning(123), false);
  status = "T";
  assert.equal(context.module.exports.processRunning(123), true);
  status = "S";
  assert.equal(context.module.exports.processRunning(123), true);
});

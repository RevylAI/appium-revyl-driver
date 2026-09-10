const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PNG } = require("pngjs");
const { RevylDriver } = require("../lib/driver");

for (const [name, mutate, expected] of [
  [
    "interlaced data",
    (png) => {
      png[28] = 1;
    },
    /Interlaced PNG/,
  ],
  [
    "oversized dimensions",
    (png) => {
      png.writeUInt32BE(16000001, 16);
    },
    /invalid PNG/,
  ],
  [
    "corrupt checksum",
    (png) => {
      png[29] ^= 255;
    },
    /invalid PNG/,
  ],
]) {
  test(`rejects ${name} before returning screenshot bytes`, async () => {
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    mutate(png);
    const driver = new RevylDriver();
    driver.client = { worker: async () => png };
    await assert.rejects(driver.getScreenshot(), expected);
  });
}

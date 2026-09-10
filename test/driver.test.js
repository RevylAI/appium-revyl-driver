const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RevylDriver } = require("../lib/driver");

test("bounds legacy text arrays before concatenation or element resolution", async () => {
  const driver = new RevylDriver();
  let resolutions = 0;
  driver.resolveElement = async () => {
    resolutions += 1;
  };
  for (const input of [
    Array(10001).fill(""),
    ["x".repeat(10001)],
    ["x".repeat(5001), "x".repeat(5000)],
    [123],
    [null],
    [{}],
  ])
    await assert.rejects(
      driver.setValue(input, "not-a-handle"),
      /10000 text characters/,
    );
  assert.equal(resolutions, 0);
});

test("bounded text arrays join once without changing insertion semantics", async () => {
  const driver = new RevylDriver();
  const field = { editable: true };
  const calls = [];
  driver.resolveElement = async () => field;
  driver.actOnElement = async (...args) => {
    calls.push(args);
  };
  await driver.setValue(["Native ", "\uD83E", "\uDDAB"], "field");
  assert.deepEqual(calls, [
    ["input", field, { text: "Native 🦫", clear_first: false }],
  ]);
});

test("reset cannot inherit BaseDriver session recreation", async () => {
  const driver = new RevylDriver();
  let lifecycleCalls = 0;
  driver.deleteSession = async () => {
    lifecycleCalls += 1;
  };
  driver.createSession = async () => {
    lifecycleCalls += 1;
  };
  await assert.rejects(driver.reset(), /reset is unsupported/i);
  assert.equal(lifecycleCalls, 0);
});

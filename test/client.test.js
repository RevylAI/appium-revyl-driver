const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { RevylClient } = require("../lib/client");

beforeEach((t) => {
  const previousEnv = process.env;
  process.env = { ...previousEnv, REVYL_API_KEY: "fake-local-test-key" };
  t.after(() => {
    process.env = previousEnv;
  });
});

async function startMock(t, handle) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  process.env.REVYL_APPIUM_API_URL = `http://127.0.0.1:${server.address().port}`;
  const client = new RevylClient("local-appium-session");
  t.after(() => client.close());
  return client;
}

test("rejects server endpoint overrides that could leak credentials", () => {
  for (const endpoint of [
    "http://example.com",
    "ftp://localhost",
    "https://user:private@example.com",
    "https://example.com/path",
    "https://example.com?private=value",
    "https://example.com#private",
    "not a URL",
  ]) {
    process.env.REVYL_APPIUM_API_URL = endpoint;
    assert.throws(
      () => new RevylClient("local"),
      (error) => !error.message.includes(endpoint),
    );
  }
});

test("requires a server credential and bounded timeout", () => {
  process.env.REVYL_API_KEY = "";
  assert.throws(() => new RevylClient("local"), /Set REVYL_API_KEY/);
  process.env.REVYL_API_KEY = "fake-local-test-key";
  process.env.REVYL_APPIUM_API_URL = "https://backend.revyl.ai";
  for (const timeout of ["0", "-1", "120001", "Infinity", "nan", "1.5"]) {
    process.env.REVYL_APPIUM_REQUEST_TIMEOUT_MS = timeout;
    assert.throws(() => new RevylClient("local"), /must be an integer/);
  }
});

test("does not follow redirects or expose error bodies", async (t) => {
  let calls = 0;
  const client = await startMock(t, (_request, response) => {
    calls += 1;
    response.writeHead(302, { Location: "/private-worker?token=not-public" });
    response.end("private server response");
  });
  await assert.rejects(client.request("device-sessions/local"), /HTTP 302/);
  assert.equal(calls, 1);
});

test("bounds streaming responses", async (t) => {
  const client = await startMock(t, (_request, response) => {
    response.writeHead(200);
    response.end(Buffer.alloc(16 * 1024 * 1024 + 1));
  });
  await assert.rejects(client.request("device-sessions/local"), /16 MiB/);
});

test("aborts active requests and clears credentials on detach", async (t) => {
  let resolveRequest;
  const received = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const client = await startMock(t, (_request, _response) => {
    resolveRequest();
  });
  const result = assert.rejects(
    client.request("device-sessions/local"),
    /cancelled/,
  );
  await received;
  client.close();
  await result;
  assert.deepEqual(client.headers, {});
});

test("forwards only the established attribution and authorization context", async (t) => {
  const client = await startMock(t, (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fake-local-test-key");
    assert.equal(request.headers["x-revyl-agent"], "Appium");
    assert.equal(
      request.headers["x-revyl-agent-session-id"],
      "local-appium-session",
    );
    response.end("[]");
  });
  assert.equal(
    (await client.request("device-sessions/local")).toString(),
    "[]",
  );
});

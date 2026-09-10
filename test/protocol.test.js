const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
} = require("node:test");

const FAKE_API_KEY = "fake-revyl-api-key-for-loopback-protocol-tests-only";
process.env.REVYL_API_KEY = FAKE_API_KEY;
const { blockedConnections } = require("./helpers/appium-server");
const { remote } = require("webdriverio");

const PACKAGE_ROOT = resolve(__dirname, "..");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const WORKFLOW_ID = "00000000-0000-4000-8000-000000000002";
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const ANDROID_HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node content-desc="root" text="" class="android.widget.FrameLayout" enabled="true" bounds="[0,0][1080,1920]">
    <node content-desc="container" text="" class="android.view.ViewGroup" enabled="true" bounds="[0,0][1080,600]">
      <node content-desc="save" resource-id="com.example.native:id/save" text="Save changes" class="android.widget.Button" enabled="true" clickable="true" bounds="[20,40][220,120]" />
      <node content-desc="name" resource-id="com.example.native:id/name" text="Existing name" class="android.widget.EditText" enabled="true" focused="false" bounds="[30,140][330,200]" />
      <node content-desc="disabled" text="Unavailable" class="android.widget.Button" enabled="false" bounds="[20,240][220,320]" />
      <node content-desc="empty" text="Hidden" class="android.widget.Button" enabled="true" bounds="[0,0][0,0]" />
    </node>
  </node>
</hierarchy>`;
const IOS_HIERARCHY = JSON.stringify([
  {
    AXUniqueId: "root",
    AXLabel: "Root",
    type: "Application",
    enabled: true,
    frame: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        AXUniqueId: "container",
        AXLabel: "Container",
        type: "Other",
        enabled: true,
        frame: { x: 0, y: 0, width: 390, height: 400 },
        children: [
          {
            AXUniqueId: "save",
            AXLabel: "Save changes",
            type: "Button",
            enabled: true,
            frame: { x: 10.5, y: 20.5, width: 101, height: 41 },
          },
          {
            AXUniqueId: "name",
            AXLabel: "Name label",
            AXValue: "Existing name",
            type: "TextField",
            enabled: true,
            frame: { x: 15.5, y: 80.5, width: 201, height: 41 },
          },
          {
            AXUniqueId: "disabled",
            AXLabel: "Unavailable",
            type: "Button",
            enabled: false,
            frame: { x: 10, y: 140, width: 100, height: 40 },
          },
        ],
      },
    ],
  },
]);

function capabilities(platformName = "Android") {
  return {
    platformName,
    "appium:automationName": "Revyl",
    "appium:revylSessionId": SESSION_ID,
    "appium:noReset": true,
  };
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejectsWithoutSecrets(command, expected) {
  await assert.rejects(command, (error) => {
    assert.match(`${error.name}: ${error.message}`, expected);
    assert.ok(
      !error.message.includes(FAKE_API_KEY),
      "Protocol error leaked the server API key",
    );
    assert.ok(
      !error.message.includes("provider-private-detail"),
      "Protocol error leaked the provider response",
    );
    return true;
  });
}

describe(
  "Appium 3.6 extension loader and WebdriverIO native protocol",
  { concurrency: false, timeout: 120000 },
  () => {
    let appiumHome;
    let mockApi;
    let appiumProcess;
    let appiumExit;
    let appiumPort;
    let serverOutput = "";
    let leakedServerKey = false;
    let leakedProviderDetail = false;
    let blockedServerConnection = false;
    let state;
    const clients = new Set();
    const killAppiumOnExit = () => appiumProcess?.kill("SIGKILL");

    before(
      async () => {
        assert.equal(require("appium/package.json").version, "3.6.0");
        appiumHome = await mkdtemp(join(tmpdir(), "revyl-appium-protocol-"));
        await mkdir(join(appiumHome, "node_modules"));
        await writeFile(
          join(appiumHome, "package.json"),
          JSON.stringify({
            name: "revyl-appium-protocol-fixture",
            private: true,
            dependencies: {
              appium: "3.6.0",
              "appium-revyl-driver": `file:${PACKAGE_ROOT}`,
            },
          }),
        );
        await symlink(
          dirname(require.resolve("appium/package.json")),
          join(appiumHome, "node_modules", "appium"),
          "junction",
        );
        await symlink(
          PACKAGE_ROOT,
          join(appiumHome, "node_modules", "appium-revyl-driver"),
          "junction",
        );

        mockApi = createServer(async (request, response) => {
          try {
            let body = "";
            for await (const chunk of request) body += chunk;
            const call = {
              method: request.method,
              path: request.url,
              headers: request.headers,
              body: body ? JSON.parse(body) : undefined,
            };
            state.requests.push(call);
            response.setHeader("Content-Type", "application/json");
            if (
              request.url ===
                `/api/v1/execution/device-sessions/${SESSION_ID}` &&
              request.method === "GET"
            ) {
              response.statusCode = state.sessionStatus;
              response.end(
                typeof state.detail === "string"
                  ? state.detail
                  : JSON.stringify(state.detail),
              );
              return;
            }
            const prefix = `/api/v1/execution/device-proxy/${WORKFLOW_ID}/`;
            if (request.url.startsWith(prefix)) {
              const action = request.url.slice(prefix.length);
              if (request.method === "GET" && action === "hierarchy") {
                response.end(state.hierarchy);
                return;
              }
              if (request.method === "GET" && action === "health") {
                const health = state.health ?? {
                  status: "ok",
                  workflow_run_id: WORKFLOW_ID,
                  platform: state.detail.platform,
                  device_connected: true,
                  screen_width: state.detail.platform === "ios" ? 390 : 1080,
                  screen_height: state.detail.platform === "ios" ? 844 : 1920,
                };
                response.end(
                  typeof health === "string" ? health : JSON.stringify(health),
                );
                return;
              }
              if (request.method === "GET" && action === "screenshot") {
                response.setHeader("Content-Type", "image/png");
                response.end(state.screenshot);
                return;
              }
              if (
                request.method === "POST" &&
                [
                  "tap",
                  "input",
                  "launch",
                  "double_tap",
                  "longpress",
                  "swipe",
                ].includes(action)
              ) {
                if (state.timeoutAction === action) return;
                response.statusCode = state.actionStatus;
                response.end(
                  JSON.stringify(
                    state.actionResult ?? {
                      success: true,
                      action: action === "longpress" ? "long_press" : action,
                      latency_ms: 1,
                      error: null,
                    },
                  ),
                );
                return;
              }
            }
            state.unexpectedRequests.push(call);
            response.statusCode = 404;
            response.end(
              JSON.stringify({ error: "Unexpected mock Revyl API request" }),
            );
          } catch (error) {
            state.mockErrors.push(error);
            response.statusCode = 500;
            response.end("{}");
          }
        });
        await bounded(
          new Promise((resolveListen, reject) => {
            mockApi.once("error", reject);
            mockApi.listen(0, "127.0.0.1", resolveListen);
          }),
          5000,
          "Mock API startup",
        );

        appiumProcess = fork(
          join(__dirname, "helpers", "appium-server.js"),
          [],
          {
            cwd: appiumHome,
            execArgv: [],
            silent: true,
            env: {
              PATH: process.env.PATH,
              HOME: appiumHome,
              TMPDIR: appiumHome,
              APPIUM_HOME: appiumHome,
              CI: "true",
              NO_COLOR: "1",
              DO_NOT_TRACK: "1",
              npm_config_offline: "true",
              npm_config_update_notifier: "false",
              REVYL_API_KEY: FAKE_API_KEY,
              REVYL_APPIUM_API_URL: `http://127.0.0.1:${mockApi.address().port}`,
              REVYL_APPIUM_REQUEST_TIMEOUT_MS: "500",
            },
          },
        );
        process.once("exit", killAppiumOnExit);
        appiumExit = new Promise((resolveExit) =>
          appiumProcess.once("exit", (code, signal) =>
            resolveExit({ code, signal }),
          ),
        );
        appiumProcess.on("message", (message) => {
          blockedServerConnection ||= message.blockedNetwork === true;
        });
        for (const output of [appiumProcess.stdout, appiumProcess.stderr]) {
          output.on("data", (chunk) => {
            serverOutput = (serverOutput + chunk).slice(-32000);
            leakedServerKey ||= serverOutput.includes(FAKE_API_KEY);
            leakedProviderDetail ||= serverOutput.includes(
              "provider-private-detail",
            );
            blockedServerConnection ||= serverOutput.includes(
              "Protocol tests forbid non-loopback",
            );
          });
        }
        appiumPort = await bounded(
          new Promise((resolvePort, reject) => {
            appiumProcess.once("error", reject);
            appiumProcess.on("message", (message) => {
              if (message.error) reject(new Error(message.error));
              else if (Number.isInteger(message.port))
                resolvePort(message.port);
            });
            appiumExit.then(({ code, signal }) =>
              reject(
                new Error(
                  `Appium exited before readiness (${code ?? signal}): ${serverOutput}`,
                ),
              ),
            );
          }),
          20000,
          "Appium startup",
        );
        const status = await fetch(`http://127.0.0.1:${appiumPort}/status`, {
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(status.status, 200);
        assert.equal((await status.json()).value.build.version, "3.6.0");
        const manifest = await readFile(
          join(
            appiumHome,
            "node_modules",
            ".cache",
            "appium",
            "extensions.yaml",
          ),
          "utf8",
        );
        assert.match(manifest, /revyl:/);
        assert.match(manifest, /mainClass: RevylDriver/);
      },
      { timeout: 30000 },
    );

    beforeEach(() => {
      state = {
        detail: {
          id: SESSION_ID,
          status: "running",
          platform: "android",
          workflow_run_id: WORKFLOW_ID,
        },
        sessionStatus: 200,
        hierarchy: ANDROID_HIERARCHY,
        screenshot: PNG,
        actionStatus: 200,
        actionResult: undefined,
        timeoutAction: undefined,
        requests: [],
        unexpectedRequests: [],
        mockErrors: [],
      };
    });

    afterEach(
      async () => {
        try {
          for (const browser of clients) await browser.deleteSession();
        } finally {
          clients.clear();
        }
        assert.deepEqual(
          state.unexpectedRequests,
          [],
          "The driver called an unsupported API or changed the remote session lifecycle",
        );
        assert.deepEqual(state.mockErrors, []);
        assert.deepEqual(
          blockedConnections,
          [],
          "A test attempted a non-loopback connection",
        );
        for (const request of state.requests) {
          assert.equal(request.headers.authorization, `Bearer ${FAKE_API_KEY}`);
        }
      },
      { timeout: 10000 },
    );

    after(
      async () => {
        try {
          if (
            appiumProcess &&
            appiumProcess.exitCode === null &&
            appiumProcess.signalCode === null
          ) {
            appiumProcess.kill("SIGTERM");
            try {
              await bounded(appiumExit, 5000, "Appium graceful shutdown");
            } catch {
              appiumProcess.kill("SIGKILL");
              await bounded(appiumExit, 5000, "Appium forced shutdown");
              assert.fail(
                "Appium required forced termination instead of a clean shutdown",
              );
            }
          }
        } finally {
          process.removeListener("exit", killAppiumOnExit);
          if (mockApi) {
            mockApi.closeAllConnections();
            await bounded(
              new Promise((resolveClose, reject) =>
                mockApi.close((error) =>
                  error ? reject(error) : resolveClose(),
                ),
              ),
              5000,
              "Mock API shutdown",
            );
          }
          if (appiumHome)
            await rm(appiumHome, { recursive: true, force: true });
        }
        assert.ok(!leakedServerKey, "Appium logs leaked the server API key");
        assert.ok(
          !leakedProviderDetail,
          "Appium logs leaked the provider response",
        );
        assert.ok(
          !blockedServerConnection,
          "Appium attempted a non-loopback connection",
        );
      },
      { timeout: 20000 },
    );

    async function createBrowser(caps = capabilities()) {
      const browser = await remote({
        protocol: "http",
        hostname: "127.0.0.1",
        port: appiumPort,
        path: "/",
        capabilities: caps,
        logLevel: "silent",
        connectionRetryCount: 0,
        connectionRetryTimeout: 5000,
        waitforTimeout: 1000,
        waitforInterval: 50,
        enableDirectConnect: false,
      });
      clients.add(browser);
      assert.ok(
        !JSON.stringify(browser.capabilities).includes(FAKE_API_KEY),
        "Returned capabilities leaked the server API key",
      );
      return browser;
    }

    const mutations = () =>
      state.requests.filter(({ method }) => method !== "GET");

    for (const platform of ["Android", "iOS"]) {
      it(`${platform}: accessibility lookup, native click/type/read/rect/screenshot/launch, and attach-only quit`, async () => {
        if (platform === "iOS") {
          state.detail.platform = "ios";
          state.hierarchy = IOS_HIERARCHY;
        }
        const browser = await createBrowser(capabilities(platform));
        assert.equal(browser.isMobile, true);
        const commands = [];
        browser.on("command", (command) => commands.push(command));
        const save = await browser.$("~save");
        assert.ok(save.elementId);
        assert.equal(await save.getText(), "Save changes");
        assert.equal(await save.isEnabled(), true);
        assert.deepEqual(
          await browser.getElementRect(save.elementId),
          platform === "Android"
            ? { x: 20, y: 40, width: 200, height: 80 }
            : { x: 10.5, y: 20.5, width: 101, height: 41 },
        );
        assert.equal(await (await browser.$("~disabled")).isEnabled(), false);
        await save.click();
        const name = await browser.$("~name");
        assert.equal(await name.getText(), "Existing name");
        await name.addValue(" + Native 🦫");
        assert.equal(
          await (await browser.$("~name")).getText(),
          "Existing name",
        );
        assert.equal(await browser.takeScreenshot(), PNG.toString("base64"));
        await browser.activateApp("com.example.native");

        assert.deepEqual(
          mutations().map(({ path, body }) => ({
            action: path.split("/").at(-1),
            body,
          })),
          [
            {
              action: "tap",
              body:
                platform === "Android" ? { x: 120, y: 80 } : { x: 61, y: 41 },
            },
            {
              action: "input",
              body: {
                ...(platform === "Android"
                  ? { x: 180, y: 170 }
                  : { x: 116, y: 101 }),
                text: " + Native 🦫",
                clear_first: false,
              },
            },
            { action: "launch", body: { bundle_id: "com.example.native" } },
          ],
        );
        assert.ok(
          commands.some(({ endpoint }) =>
            endpoint.endsWith(`/element/${save.elementId}/click`),
          ),
        );
        assert.ok(
          commands.some(({ endpoint }) =>
            endpoint.endsWith(`/element/${name.elementId}/value`),
          ),
        );
        assert.ok(
          commands.some(({ endpoint }) =>
            endpoint.endsWith("/appium/device/activate_app"),
          ),
        );
        assert.ok(
          !commands.some(({ endpoint }) =>
            /\/actions$|\/execute\//.test(endpoint),
          ),
        );
        const requestCountBeforeQuit = state.requests.length;
        await browser.deleteSession();
        clients.delete(browser);
        assert.equal(
          state.requests.length,
          requestCountBeforeQuit,
          "Quitting must not cancel/delete/stop the Revyl session",
        );
      });
    }

    async function createPlatformBrowser(platform) {
      state.detail.platform = platform.toLowerCase();
      state.hierarchy = platform === "iOS" ? IOS_HIERARCHY : ANDROID_HIERARCHY;
      return createBrowser(capabilities(platform));
    }

    for (const platform of ["Android", "iOS"]) {
      it(`${platform}: exposes native contexts without changing the remote device or expiring handles`, async () => {
        const browser = await createPlatformBrowser(platform);
        const save = await browser.$("~save");
        const requestCount = state.requests.length;
        assert.deepEqual(await browser.getAppiumContexts(), ["NATIVE_APP"]);
        assert.equal(await browser.getAppiumContext(), "NATIVE_APP");
        await browser.switchAppiumContext("NATIVE_APP");
        assert.equal(state.requests.length, requestCount);
        for (const context of [
          "WEBVIEW_com.example.native",
          "CHROMIUM",
          "native_app",
          "",
        ]) {
          await rejectsWithoutSecrets(
            () => browser.switchAppiumContext(context),
            /unsupported|only NATIVE_APP/i,
          );
        }
        assert.equal(await browser.getAppiumContext(), "NATIVE_APP");
        assert.equal(
          await browser.getElementText(save.elementId),
          "Save changes",
        );
        assert.deepEqual(mutations(), []);
      });

      it(`${platform}: exact native type lookup and allowlisted attributes preserve raw semantics`, async () => {
        const browser = await createPlatformBrowser(platform);
        const name = await browser.findElement(
          "class name",
          platform === "Android" ? "android.widget.EditText" : "TextField",
        );
        assert.equal(
          await browser.getElementText(name[ELEMENT_KEY]),
          "Existing name",
        );
        assert.equal(
          await browser.getElementAttribute(name[ELEMENT_KEY], "enabled"),
          "true",
        );
        if (platform === "Android") {
          assert.equal(
            await browser.getElementAttribute(name[ELEMENT_KEY], "resource-id"),
            "com.example.native:id/name",
          );
          assert.equal(
            await browser.getElementAttribute(
              name[ELEMENT_KEY],
              "content-desc",
            ),
            "name",
          );
          assert.equal(
            await browser.getElementAttribute(name[ELEMENT_KEY], "focused"),
            "false",
          );
          assert.equal(
            await browser.getElementAttribute(name[ELEMENT_KEY], "selected"),
            null,
          );
          const byId = await browser.findElement(
            "id",
            "com.example.native:id/name",
          );
          assert.equal(
            await browser.getElementText(byId[ELEMENT_KEY]),
            "Existing name",
          );
          assert.deepEqual(await browser.findElements("id", "name"), []);
        } else {
          assert.equal(
            await browser.getElementAttribute(name[ELEMENT_KEY], "AXUniqueId"),
            "name",
          );
          assert.equal(
            await browser.getElementAttribute(name[ELEMENT_KEY], "AXLabel"),
            "Name label",
          );
          assert.equal(
            await browser.getElementAttribute(name[ELEMENT_KEY], "AXValue"),
            "Existing name",
          );
          const save = await browser.$("~save");
          assert.equal(
            await browser.getElementAttribute(save.elementId, "AXValue"),
            null,
          );
          assert.deepEqual(
            await browser.findElements(
              "class name",
              "XCUIElementTypeTextField",
            ),
            [],
          );
          await rejectsWithoutSecrets(
            () => browser.findElements("id", "name"),
            /Android-only|invalid selector/i,
          );
        }
        for (const attribute of [
          "displayed",
          "private-property",
          "__proto__",
          "constructor",
          "toString",
        ])
          await rejectsWithoutSecrets(
            () => browser.getElementAttribute(name[ELEMENT_KEY], attribute),
            /not supported|unsupported/i,
          );
        assert.deepEqual(mutations(), []);
      });

      it(`${platform}: scoped searches include descendants, exclude self and outside duplicates, and return independent handles`, async () => {
        const browser = await createPlatformBrowser(platform);
        if (platform === "Android") {
          state.hierarchy = state.hierarchy.replace(
            "</hierarchy>",
            '<node content-desc="save" text="Outside" class="android.widget.Button" enabled="true" bounds="[400,40][600,120]" /></hierarchy>',
          );
        } else {
          const roots = JSON.parse(state.hierarchy);
          roots.push({
            AXUniqueId: "save",
            AXLabel: "Outside",
            type: "Button",
            enabled: true,
            frame: { x: 0, y: 500, width: 100, height: 40 },
          });
          state.hierarchy = JSON.stringify(roots);
        }
        const all = await browser.findElements("accessibility id", "save");
        assert.equal(all.length, 2);
        assert.equal(
          await browser.getElementText(all[0][ELEMENT_KEY]),
          "Save changes",
        );
        assert.equal(
          await browser.getElementText(all[1][ELEMENT_KEY]),
          "Outside",
        );
        const root = await browser.$("~root");
        const container = await browser.$("~container");
        const inside = await browser.findElementsFromElement(
          root.elementId,
          "accessibility id",
          "save",
        );
        assert.equal(inside.length, 1);
        assert.notEqual(inside[0][ELEMENT_KEY], all[0][ELEMENT_KEY]);
        assert.equal(
          await browser.getElementText(inside[0][ELEMENT_KEY]),
          "Save changes",
        );
        assert.deepEqual(
          await browser.findElementsFromElement(
            container.elementId,
            "accessibility id",
            "container",
          ),
          [],
        );
        assert.deepEqual(
          await browser.findElementsFromElement(
            inside[0][ELEMENT_KEY],
            "accessibility id",
            "save",
          ),
          [],
        );
        const field = await browser.findElementFromElement(
          container.elementId,
          "class name",
          platform === "Android" ? "android.widget.EditText" : "TextField",
        );
        assert.equal(
          await browser.getElementText(field[ELEMENT_KEY]),
          "Existing name",
        );
        if (platform === "Android") {
          const byId = await browser.findElementFromElement(
            root.elementId,
            "id",
            "com.example.native:id/name",
          );
          assert.equal(
            await browser.getElementText(byId[ELEMENT_KEY]),
            "Existing name",
          );
        }
        state.hierarchy += "\n";
        await rejectsWithoutSecrets(
          () =>
            browser.findElementsFromElement(
              root.elementId,
              "accessibility id",
              "save",
            ),
          /stale element reference/i,
        );
        await rejectsWithoutSecrets(
          () => browser.getElementAttribute(all[0][ELEMENT_KEY], "enabled"),
          /stale element reference/i,
        );
        assert.deepEqual(mutations(), []);
      });

      it(`${platform}: clear never mutates even a uniquely identified editable field`, async () => {
        const browser = await createPlatformBrowser(platform);
        const name = await browser.$("~name");
        const requestCount = state.requests.length;
        await rejectsWithoutSecrets(
          () => browser.elementClear(name.elementId),
          /clear requires a worker contract|unsupported/i,
        );
        assert.equal(state.requests.length, requestCount);
        assert.equal(
          await browser.getElementText(name.elementId),
          "Existing name",
        );
        assert.deepEqual(mutations(), []);
      });

      it(`${platform}: named native gestures use exact worker endpoints, units, defaults, and attribution`, async () => {
        const browser = await createPlatformBrowser(platform);
        const commands = [];
        browser.on("command", (command) => commands.push(command));
        await browser.execute("revyl:tap", { x: 20, y: 30 });
        await browser.executeScript("revyl:doubleTap", [{ x: 21, y: 31 }]);
        await browser.executeScript("revyl:longPress", [{ x: 22, y: 32 }]);
        await browser.executeScript("revyl:longPress", [
          { x: 22, y: 32, durationMs: 2345 },
        ]);
        await browser.executeScript("revyl:swipe", [
          { x: 100, y: 200, direction: "up" },
        ]);
        for (const direction of ["down", "left", "right"])
          await browser.executeScript("revyl:swipe", [
            { x: 100, y: 200, direction, durationMs: 456 },
          ]);
        assert.deepEqual(
          mutations().map(({ path, body }) => ({
            action: path.split("/").at(-1),
            body,
          })),
          [
            { action: "tap", body: { x: 20, y: 30 } },
            { action: "double_tap", body: { x: 21, y: 31 } },
            { action: "longpress", body: { x: 22, y: 32, duration_ms: 1500 } },
            { action: "longpress", body: { x: 22, y: 32, duration_ms: 2345 } },
            {
              action: "swipe",
              body: { x: 100, y: 200, duration_ms: 500, direction: "up" },
            },
            ...["down", "left", "right"].map((direction) => ({
              action: "swipe",
              body: { x: 100, y: 200, duration_ms: 456, direction },
            })),
          ],
        );
        for (const request of mutations()) {
          assert.equal(request.headers["x-revyl-agent"], "Appium");
          assert.equal(
            request.headers["x-revyl-agent-session-id"],
            browser.sessionId,
          );
        }
        assert.ok(
          commands.filter(({ endpoint }) => endpoint.endsWith("/execute/sync"))
            .length === 8,
        );
        const requestCount = state.requests.length;
        await browser.deleteSession();
        clients.delete(browser);
        assert.equal(state.requests.length, requestCount);
      });
    }

    it("scoped implicit waits fail stale instead of rebinding the parent after a hierarchy change", async () => {
      const browser = await createBrowser();
      const container = await browser.$("~container");
      await browser.setTimeout({ implicit: 1000 });
      const timer = setTimeout(() => {
        state.hierarchy += "\n";
      }, 30);
      try {
        await rejectsWithoutSecrets(
          () =>
            browser.findElementsFromElement(
              container.elementId,
              "accessibility id",
              "missing",
            ),
          /stale element reference/i,
        );
      } finally {
        clearTimeout(timer);
      }
      assert.deepEqual(mutations(), []);
    });

    it("rejects unknown scope handles and oversized selectors without device mutations", async () => {
      const browser = await createBrowser();
      await rejectsWithoutSecrets(
        () =>
          browser.findElementsFromElement(
            "not-a-handle",
            "accessibility id",
            "save",
          ),
        /stale element reference/i,
      );
      for (const strategy of ["accessibility id", "id", "class name"]) {
        for (const selector of ["", "x".repeat(1025)])
          await rejectsWithoutSecrets(
            () => browser.findElements(strategy, selector),
            /invalid selector|1–1024/i,
          );
      }
      assert.deepEqual(mutations(), []);
    });

    it("rejects JavaScript, mobile aliases, future features, and arbitrary worker endpoints before contacting Revyl", async () => {
      const browser = await createBrowser();
      const requestCount = state.requests.length;
      for (const script of [
        "mobile: clickGesture",
        "mobile: tap",
        "revyl:drag",
        "revyl:pinch",
        "revyl:clear",
        "revyl:installApp",
        "revyl:reset",
        "revyl:tap/../../install",
        "revyl: tap",
        "return document.title",
        "constructor",
        "__proto__",
        "toString",
      ])
        await rejectsWithoutSecrets(
          () => browser.executeScript(script, [{ x: 20, y: 30 }]),
          /unsupported|supported/i,
        );
      await rejectsWithoutSecrets(
        () => browser.installApp("/not-a-real-app.apk"),
        /unsupported|not.*implemented/i,
      );
      await rejectsWithoutSecrets(
        () => browser.releaseActions(),
        /unsupported|not.*implemented/i,
      );
      assert.equal(state.requests.length, requestCount);
      assert.deepEqual(mutations(), []);
    });

    const malformedGestures = [
      ["missing options", "revyl:tap", []],
      ["multiple options", "revyl:tap", [{ x: 20, y: 30 }, {}]],
      ["null options", "revyl:tap", [null]],
      ["array options", "revyl:tap", [[20, 30]]],
      ["missing coordinates", "revyl:tap", [{}]],
      ["string coordinate", "revyl:tap", [{ x: "20", y: 30 }]],
      ["fractional coordinate", "revyl:tap", [{ x: 20.5, y: 30 }]],
      ["negative coordinate", "revyl:tap", [{ x: -1, y: 30 }]],
      ["oversized coordinate", "revyl:tap", [{ x: 32768, y: 30 }]],
      [
        "unknown parameter",
        "revyl:tap",
        [{ x: 20, y: 30, elementId: "unknown" }],
      ],
      [
        "client credential",
        "revyl:tap",
        [{ x: 20, y: 30, apiKey: "fake-client-key" }],
      ],
      ["ignored tap duration", "revyl:tap", [{ x: 20, y: 30, durationMs: 10 }]],
      [
        "ignored double tap interval",
        "revyl:doubleTap",
        [{ x: 20, y: 30, intervalMs: 10 }],
      ],
      ["zero duration", "revyl:longPress", [{ x: 20, y: 30, durationMs: 0 }]],
      [
        "unbounded duration",
        "revyl:longPress",
        [{ x: 20, y: 30, durationMs: 10001 }],
      ],
      [
        "string duration",
        "revyl:longPress",
        [{ x: 20, y: 30, durationMs: "100" }],
      ],
      [
        "null duration",
        "revyl:longPress",
        [{ x: 20, y: 30, durationMs: null }],
      ],
      [
        "fractional duration",
        "revyl:swipe",
        [{ x: 20, y: 30, direction: "up", durationMs: 0.5 }],
      ],
      ["missing direction", "revyl:swipe", [{ x: 20, y: 30 }]],
      [
        "ambiguous direction",
        "revyl:swipe",
        [{ x: 20, y: 30, direction: "UP" }],
      ],
      [
        "ignored distance",
        "revyl:swipe",
        [{ x: 20, y: 30, direction: "up", percent: 0.5 }],
      ],
    ];
    for (const [name, script, args] of malformedGestures) {
      it(`rejects ${name} before any gesture request`, async () => {
        const browser = await createBrowser();
        const requestCount = state.requests.length;
        await rejectsWithoutSecrets(
          () => browser.executeScript(script, args),
          /invalid argument|requires|must|options/i,
        );
        assert.equal(state.requests.length, requestCount);
        assert.deepEqual(mutations(), []);
      });
    }

    it("rejects off-screen native element centers and gestures, rather than clamping or tapping", async () => {
      const browser = await createBrowser();
      for (const coordinates of [
        { x: 1080, y: 20 },
        { x: 20, y: 1920 },
      ])
        await rejectsWithoutSecrets(
          () => browser.executeScript("revyl:tap", [coordinates]),
          /inside the native screen/i,
        );
      for (const options of [
        { x: 0, y: 10, direction: "left" },
        { x: 10, y: 0, direction: "up" },
        { x: 1079, y: 10, direction: "right" },
        { x: 10, y: 1919, direction: "down" },
      ])
        await rejectsWithoutSecrets(
          () => browser.executeScript("revyl:swipe", [options]),
          /no usable travel/i,
        );
      state.hierarchy = state.hierarchy.replace(
        "[20,40][220,120]",
        "[2000,40][2200,120]",
      );
      const save = await browser.$("~save");
      await rejectsWithoutSecrets(
        () => browser.elementClick(save.elementId),
        /outside the screen/i,
      );
      assert.deepEqual(mutations(), []);
    });

    for (const invalidHealth of [
      "not-json",
      "null",
      {},
      {
        status: "ok",
        device_connected: true,
        workflow_run_id: WORKFLOW_ID,
        platform: "android",
        screen_width: "1080",
        screen_height: 1920,
      },
      {
        status: "ok",
        device_connected: true,
        workflow_run_id: SESSION_ID,
        platform: "android",
        screen_width: 1080,
        screen_height: 1920,
      },
      {
        status: "ok",
        device_connected: true,
        workflow_run_id: WORKFLOW_ID,
        platform: "ios",
        screen_width: 390,
        screen_height: 844,
      },
    ]) {
      it(`rejects untrusted geometry ${JSON.stringify(invalidHealth)}`, async () => {
        const browser = await createBrowser();
        state.health = invalidHealth;
        await rejectsWithoutSecrets(
          () => browser.executeScript("revyl:tap", [{ x: 20, y: 30 }]),
          /invalid device geometry/i,
        );
        assert.deepEqual(mutations(), []);
      });
    }

    for (const [script, action, options] of [
      ["revyl:tap", "tap", { x: 20, y: 30 }],
      ["revyl:doubleTap", "double_tap", { x: 20, y: 30 }],
      ["revyl:longPress", "longpress", { x: 20, y: 30 }],
      ["revyl:swipe", "swipe", { x: 20, y: 30, direction: "down" }],
    ]) {
      for (const outcome of [
        "success",
        "timeout",
        "failure",
        "wrong action",
        "access denied",
      ]) {
        it(`${script}: ${outcome} invalidates handles without replay`, async () => {
          const browser = await createBrowser();
          const save = await browser.$("~save");
          const root = await browser.$("~root");
          if (outcome === "timeout") state.timeoutAction = action;
          if (outcome === "failure")
            state.actionResult = {
              success: false,
              action,
              error: `${FAKE_API_KEY}: provider-private-detail`,
            };
          if (outcome === "wrong action")
            state.actionResult = {
              success: true,
              action: action === "longpress" ? "longpress" : "install",
              error: null,
            };
          if (outcome === "access denied") state.actionStatus = 403;
          const command = () => browser.executeScript(script, [options]);
          if (outcome === "success") await command();
          else
            await rejectsWithoutSecrets(
              command,
              /timed out|timeout|did not confirm success|denied access/i,
            );
          assert.equal(mutations().length, 1);
          await rejectsWithoutSecrets(
            () => browser.elementClick(save.elementId),
            /stale element reference/i,
          );
          await rejectsWithoutSecrets(
            () =>
              browser.findElementsFromElement(
                root.elementId,
                "accessibility id",
                "save",
              ),
            /stale element reference/i,
          );
          assert.equal(mutations().length, 1);
          if (outcome !== "access denied")
            assert.equal(
              await (await browser.$("~save")).getText(),
              "Save changes",
            );
        });
      }
    }

    it("rejects malformed Unicode, control characters, special keys, and oversized input before contacting Revyl", async () => {
      const browser = await createBrowser();
      const name = await browser.$("~name");
      const requestCount = state.requests.length;
      for (const text of [
        "\uD800",
        "\uDC00",
        "\u0000",
        "\n",
        "\t",
        "\u007F",
        "\u0085",
        "\uE007",
        "x".repeat(10001),
      ])
        await rejectsWithoutSecrets(
          () => browser.elementSendKeys(name.elementId, text),
          /invalid argument|text characters|special keys/i,
        );
      assert.equal(state.requests.length, requestCount);
      assert.deepEqual(mutations(), []);
      await browser.elementSendKeys(name.elementId, "");
      assert.deepEqual(mutations(), []);
      await browser.elementSendKeys(
        name.elementId,
        "Español Ελληνικά 日本語 🦫",
      );
      assert.equal(mutations().length, 1);
      assert.equal(mutations()[0].body.text, "Español Ελληνικά 日本語 🦫");
      assert.equal(mutations()[0].body.clear_first, false);
    });

    const badCapabilities = [
      [
        "missing session ID",
        (caps) => {
          delete caps["appium:revylSessionId"];
        },
      ],
      [
        "malformed session ID",
        (caps) => {
          caps["appium:revylSessionId"] = "../not-a-uuid";
        },
      ],
      [
        "non-string session ID",
        (caps) => {
          caps["appium:revylSessionId"] = 123;
        },
      ],
      [
        "missing platform",
        (caps) => {
          delete caps.platformName;
        },
      ],
      [
        "unsupported platform",
        (caps) => {
          caps.platformName = "Linux";
        },
      ],
      [
        "missing automation name",
        (caps) => {
          delete caps["appium:automationName"];
        },
      ],
      [
        "reset request",
        (caps) => {
          caps["appium:noReset"] = false;
        },
      ],
      [
        "full reset request",
        (caps) => {
          caps["appium:fullReset"] = true;
        },
      ],
      [
        "app installation request",
        (caps) => {
          caps["appium:app"] = "/not-a-real-app.apk";
        },
      ],
      [
        "client API URL override",
        (caps) => {
          caps["appium:revylApiUrl"] = "http://127.0.0.1:1";
        },
      ],
      [
        "client API key override",
        (caps) => {
          caps["appium:revylApiKey"] = "fake-client-supplied-key";
        },
      ],
      [
        "web browser session",
        (caps) => {
          caps.browserName = "Chrome";
        },
      ],
    ];
    for (const [name, changeCaps] of badCapabilities) {
      it(`rejects ${name} before contacting Revyl`, async () => {
        const caps = capabilities();
        changeCaps(caps);
        await rejectsWithoutSecrets(
          () => createBrowser(caps),
          /capabilit|platform|automation|UUID|reset|install|attach-only|driver/i,
        );
        assert.equal(state.requests.length, 0);
      });
    }

    for (const status of [401, 403]) {
      it(`rejects attach authorization HTTP ${status} without revealing credentials or provider errors`, async () => {
        state.sessionStatus = status;
        state.detail = { error: `${FAKE_API_KEY}: provider-private-detail` };
        await rejectsWithoutSecrets(
          () => createBrowser(),
          /denied access|permission|API key/i,
        );
        assert.equal(state.requests.length, 1);
        assert.deepEqual(mutations(), []);
      });
    }

    const invalidSessions = [
      ["wrong platform", (detail) => ({ ...detail, platform: "ios" })],
      ["non-running session", (detail) => ({ ...detail, status: "completed" })],
      ["different session ID", (detail) => ({ ...detail, id: WORKFLOW_ID })],
      ["missing workflow ID", ({ workflow_run_id, ...detail }) => detail],
      [
        "malformed workflow ID",
        (detail) => ({ ...detail, workflow_run_id: "not-a-uuid" }),
      ],
      ["malformed JSON", () => "{"],
      ["null session response", () => null],
    ];
    for (const [name, response] of invalidSessions) {
      it(`rejects ${name} without contacting a device proxy`, async () => {
        state.detail = response(state.detail);
        await rejectsWithoutSecrets(
          () => createBrowser(),
          /session|platform|workflow|response/i,
        );
        assert.equal(state.requests.length, 1);
        assert.deepEqual(mutations(), []);
      });
    }

    it("reports missing accessibility IDs as no such element and an empty list", async () => {
      const browser = await createBrowser();
      const missing = await browser.findElement("accessibility id", "missing");
      assert.equal(missing.error, "no such element");
      assert.equal(missing[ELEMENT_KEY], undefined);
      assert.deepEqual(
        await browser.findElements("accessibility id", "missing"),
        [],
      );
      assert.deepEqual(mutations(), []);
    });

    it("rejects XPath, element-scoped XPath, W3C actions, arbitrary execute, and webview switching explicitly", async () => {
      const browser = await createBrowser();
      const element = await browser.$("~save");
      const unsupported =
        /not (?:yet )?(?:been )?(?:implemented|supported)|unsupported|invalid selector/i;
      await rejectsWithoutSecrets(
        () => browser.findElement("xpath", "//*"),
        unsupported,
      );
      await rejectsWithoutSecrets(
        () =>
          browser.findElementFromElement(element.elementId, "xpath", ".//*"),
        unsupported,
      );
      await rejectsWithoutSecrets(
        () =>
          browser.performActions([
            {
              type: "pointer",
              id: "finger",
              parameters: { pointerType: "touch" },
              actions: [{ type: "pointerMove", x: 20, y: 20, duration: 0 }],
            },
          ]),
        unsupported,
      );
      await rejectsWithoutSecrets(
        () => browser.executeScript("return 1", []),
        unsupported,
      );
      await rejectsWithoutSecrets(
        () => browser.switchAppiumContext("WEBVIEW_com.example.native"),
        unsupported,
      );
      assert.deepEqual(mutations(), []);
    });

    for (const mutation of ["tap", "input", "launch"]) {
      it(`invalidates previous element references after ${mutation}, even if the hierarchy bytes are unchanged`, async () => {
        const browser = await createBrowser();
        const save = await browser.$("~save");
        if (mutation === "tap") await save.click();
        if (mutation === "input")
          await (await browser.$("~name")).addValue("new");
        if (mutation === "launch")
          await browser.activateApp("com.example.native");
        assert.equal(mutations().length, 1);
        await rejectsWithoutSecrets(
          () => browser.elementClick(save.elementId),
          /stale element reference/i,
        );
        assert.equal(
          mutations().length,
          1,
          "A stale reference must not trigger another tap",
        );
        assert.equal(
          await (await browser.$("~save")).getText(),
          "Save changes",
        );
      });
    }

    for (const platform of ["Android", "iOS"]) {
      it(`${platform}: raw hierarchy changes make cached elements stale without a tap`, async () => {
        if (platform === "iOS") {
          state.detail.platform = "ios";
          state.hierarchy = IOS_HIERARCHY;
        }
        const browser = await createBrowser(capabilities(platform));
        const save = await browser.$("~save");
        state.hierarchy += "\n";
        await rejectsWithoutSecrets(
          () => browser.elementClick(save.elementId),
          /stale element reference/i,
        );
        await rejectsWithoutSecrets(
          () => browser.getElementText(save.elementId),
          /stale element reference/i,
        );
        assert.deepEqual(mutations(), []);
        assert.equal(
          await (await browser.$("~save")).getText(),
          "Save changes",
        );
      });
    }

    it("rejects disabled or zero-area native elements without a tap", async () => {
      const browser = await createBrowser();
      for (const identifier of ["disabled", "empty"]) {
        const element = await browser.$(`~${identifier}`);
        await rejectsWithoutSecrets(
          () => browser.elementClick(element.elementId),
          /not interactable|disabled|bounds/i,
        );
      }
      assert.deepEqual(mutations(), []);
    });

    it("an observed hierarchy change invalidates every old reference even if the original hierarchy returns", async () => {
      const browser = await createBrowser();
      const originalSave = await browser.$("~save");
      const originalName = await browser.$("~name");
      state.hierarchy += "\n";
      assert.equal(await (await browser.$("~save")).getText(), "Save changes");
      state.hierarchy = ANDROID_HIERARCHY;
      await rejectsWithoutSecrets(
        () => browser.elementClick(originalSave.elementId),
        /stale element reference/i,
      );
      await rejectsWithoutSecrets(
        () => browser.elementSendKeys(originalName.elementId, "must not type"),
        /stale element reference/i,
      );
      assert.deepEqual(mutations(), []);
    });

    it("rejects typing into a non-editable element and special WebDriver keys without an action", async () => {
      const browser = await createBrowser();
      const button = await browser.$("~save");
      const name = await browser.$("~name");
      await rejectsWithoutSecrets(
        () => button.addValue("text"),
        /invalid element state|editable/i,
      );
      await rejectsWithoutSecrets(
        () => name.addValue("\uE007"),
        /invalid argument|special keys/i,
      );
      assert.deepEqual(mutations(), []);
    });

    for (const action of ["tap", "input", "launch"]) {
      it(`${action} timeout is surfaced without retry and invalidates old references`, async () => {
        const browser = await createBrowser();
        const save = await browser.$("~save");
        const name = await browser.$("~name");
        state.timeoutAction = action;
        const command =
          action === "tap"
            ? () => save.click()
            : action === "input"
              ? () => name.addValue("once")
              : () => browser.activateApp("com.example.native");
        await rejectsWithoutSecrets(command, /timed out|timeout/i);
        assert.equal(
          mutations().length,
          1,
          "Timed-out mutations must not be retried",
        );
        await rejectsWithoutSecrets(
          () => browser.elementClick(save.elementId),
          /stale element reference/i,
        );
        assert.equal(mutations().length, 1);
      });
    }

    for (const action of ["tap", "input", "launch"]) {
      it(`HTTP 200 success:false for ${action} fails without retries or provider error leakage`, async () => {
        const browser = await createBrowser();
        const save = await browser.$("~save");
        state.actionResult = {
          success: false,
          action,
          latency_ms: 1,
          error: `${FAKE_API_KEY}: provider-private-detail`,
        };
        const command =
          action === "tap"
            ? () => save.click()
            : action === "input"
              ? async () => (await browser.$("~name")).addValue("once")
              : () => browser.activateApp("com.example.native");
        await rejectsWithoutSecrets(command, /did not confirm success|failed/i);
        assert.equal(mutations().length, 1);
        await rejectsWithoutSecrets(
          () => browser.elementClick(save.elementId),
          /stale element reference/i,
        );
        assert.equal(mutations().length, 1);
      });
    }

    it("rejects malformed screenshot data instead of returning it as base64 PNG", async () => {
      const browser = await createBrowser();
      state.screenshot = Buffer.from('{"error":"not an image"}');
      await rejectsWithoutSecrets(
        () => browser.takeScreenshot(),
        /invalid PNG|screenshot/i,
      );
      assert.deepEqual(mutations(), []);
    });

    it("rejects a truncated PNG containing only its valid signature", async () => {
      const browser = await createBrowser();
      state.screenshot = PNG.subarray(0, 8);
      await rejectsWithoutSecrets(
        () => browser.takeScreenshot(),
        /invalid PNG|screenshot/i,
      );
      assert.deepEqual(mutations(), []);
    });

    it("a deleted Appium session cannot be reused and does not delete the remote session", async () => {
      const browser = await createBrowser();
      const element = await browser.$("~save");
      await browser.deleteSession();
      clients.delete(browser);
      const requestCount = state.requests.length;
      await rejectsWithoutSecrets(
        () => browser.elementClick(element.elementId),
        /invalid session id|session.*(?:not|terminated|started)/i,
      );
      assert.equal(state.requests.length, requestCount);
      assert.deepEqual(mutations(), []);
    });
  },
);

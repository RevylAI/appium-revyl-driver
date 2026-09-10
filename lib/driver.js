const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { BaseDriver, errors, W3C_ELEMENT_KEY } = require("appium/driver");
const { PNG } = require("pngjs");
const { RevylClient, UUID } = require("./client");
const { parseHierarchy, NATIVE_ATTRIBUTES } = require("./hierarchy");

const CAPABILITIES = new Set([
  "platformName",
  "automationName",
  "revylSessionId",
  "newCommandTimeout",
  "deviceName",
  "noReset",
  "fullReset",
]);

const GESTURES = Object.freeze({
  "revyl:tap": "tap",
  "revyl:doubleTap": "double_tap",
  "revyl:longPress": "longpress",
  "revyl:swipe": "swipe",
});

class RevylDriver extends BaseDriver {
  constructor(...args) {
    super(...args);
    this.desiredCapConstraints = {
      platformName: {
        presence: true,
        inclusionCaseInsensitive: ["Android", "iOS"],
      },
      automationName: { presence: true, inclusionCaseInsensitive: ["Revyl"] },
      revylSessionId: { presence: true, isString: true },
    };
    this.locatorStrategies = ["accessibility id", "id", "class name"];
    this.elements = new Map();
  }

  async createSession(...args) {
    if (this.sessionId !== null) {
      throw new errors.SessionNotCreatedError(
        "An Appium session is already active.",
      );
    }
    try {
      const [sessionId, caps] = await super.createSession(...args);
      if (!UUID.test(caps.revylSessionId)) {
        throw new errors.InvalidArgumentError(
          "appium:revylSessionId must be a device-session UUID.",
        );
      }
      if (Object.keys(caps).some((key) => !CAPABILITIES.has(key))) {
        throw new errors.InvalidArgumentError(
          "Unsupported capability. This attach-only driver accepts platformName, automationName, revylSessionId, deviceName, noReset, fullReset, and newCommandTimeout only.",
        );
      }
      if (caps.noReset === false || caps.fullReset === true) {
        throw new errors.InvalidArgumentError(
          "Revyl attaches without resetting or installing an app. Set appium:noReset=true and omit appium:fullReset.",
        );
      }
      this.platformName =
        caps.platformName.toLowerCase() === "ios" ? "iOS" : "Android";
      this.client = new RevylClient(sessionId);
      await this.client.attach(caps.revylSessionId, this.platformName);
      await this.readHierarchy();
      this.log.info(
        "Attached to a running Revyl session; its lifecycle remains externally owned.",
      );
      this.caps.noReset = true;
      return [sessionId, this.caps];
    } catch (error) {
      await this.deleteSession();
      throw error;
    }
  }

  async deleteSession() {
    this.client?.close();
    this.client = undefined;
    this.elements.clear();
    this.hierarchyFingerprint = undefined;
    await super.deleteSession();
  }

  async readHierarchy() {
    try {
      const snapshot = parseHierarchy(
        await this.client.worker("hierarchy"),
        this.platformName,
      );
      if (snapshot.fingerprint !== this.hierarchyFingerprint)
        this.elements.clear();
      this.hierarchyFingerprint = snapshot.fingerprint;
      return snapshot;
    } catch (error) {
      this.elements.clear();
      this.hierarchyFingerprint = undefined;
      throw error;
    }
  }

  async findElOrEls(strategy, selector, multiple, context) {
    if (!this.locatorStrategies.includes(strategy))
      throw new errors.InvalidSelectorError(
        "Revyl supports accessibility id, native class name, and Android resource id only.",
      );
    if (strategy === "id" && this.platformName !== "Android")
      throw new errors.InvalidSelectorError(
        "Resource id lookup is Android-only.",
      );
    if (typeof selector !== "string" || !selector || selector.length > 1024) {
      throw new errors.InvalidSelectorError(
        "Native selectors must contain 1–1024 characters.",
      );
    }
    if (
      !Number.isFinite(this.implicitWaitMs) ||
      this.implicitWaitMs < 0 ||
      this.implicitWaitMs > 120000
    ) {
      throw new errors.InvalidArgumentError(
        "Revyl supports an implicit wait of at most 120000 ms.",
      );
    }
    const deadline = performance.now() + this.implicitWaitMs;
    do {
      const snapshot = await this.readHierarchy();
      const parent =
        context === undefined
          ? undefined
          : await this.resolveElement(context, snapshot);
      const found = snapshot.elements.filter((element) => {
        if (
          parent &&
          (element.index <= parent.index || element.index >= parent.subtreeEnd)
        )
          return false;
        if (strategy === "accessibility id")
          return element.identifier === selector;
        const attribute =
          strategy === "id"
            ? "resource-id"
            : this.platformName === "Android"
              ? "class"
              : "type";
        return element.attributes[attribute] === selector;
      });
      if (found.length) {
        const selected = multiple ? found : found.slice(0, 1);
        if (this.elements.size + selected.length > 10000) {
          throw new errors.UnknownError(
            "Element-reference limit reached. Start a new Appium session.",
          );
        }
        const references = selected.map((element) => {
          const id = randomUUID();
          this.elements.set(
            id,
            Object.freeze({
              ...element,
              fingerprint: snapshot.fingerprint,
            }),
          );
          return { [W3C_ELEMENT_KEY]: id };
        });
        return multiple ? references : references[0];
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(500, remainingMs), undefined, {
        signal: this.client.abortController.signal,
      });
    } while (true);
    if (multiple) return [];
    throw new errors.NoSuchElementError(
      "No native element matches that selector in the requested scope.",
    );
  }

  async resolveElement(elementId, snapshot) {
    const element = this.elements.get(elementId);
    if (
      !element ||
      element.fingerprint !==
        (snapshot ?? (await this.readHierarchy())).fingerprint
    ) {
      this.elements.delete(elementId);
      throw new errors.StaleElementReferenceError(
        "The native hierarchy changed or this reference expired. Find the element again.",
      );
    }
    return element;
  }

  async click(elementId) {
    const element = await this.resolveElement(elementId);
    return this.actOnElement("tap", element);
  }

  async setValue(value, elementId) {
    if (
      Array.isArray(value) &&
      (value.length > 10000 ||
        value.some((part) => typeof part !== "string" || part.length > 10000) ||
        value.reduce((length, part) => length + part.length, 0) > 10000)
    )
      throw new errors.InvalidArgumentError(
        "sendKeys supports up to 10000 text characters.",
      );
    const text = Array.isArray(value) ? value.join("") : value;
    if (
      typeof text !== "string" ||
      text.length > 10000 ||
      !text.isWellFormed() ||
      /[\u0000-\u001F\u007F-\u009F\uE000-\uF8FF]/u.test(text)
    ) {
      throw new errors.InvalidArgumentError(
        "sendKeys supports up to 10000 well-formed text characters, not control characters or WebDriver special keys.",
      );
    }
    const element = await this.resolveElement(elementId);
    if (!element.editable)
      throw new errors.InvalidElementStateError(
        "The hierarchy does not identify this element as an editable native field.",
      );
    if (!text) return;
    return this.actOnElement("input", element, { text, clear_first: false });
  }

  async actOnElement(action, element, body = {}) {
    const { x, y, width, height } = element.rect;
    const centerX = Math.floor(x + width / 2);
    const centerY = Math.floor(y + height / 2);
    if (
      !element.enabled ||
      width <= 0 ||
      height <= 0 ||
      centerX < 0 ||
      centerY < 0
    ) {
      throw new errors.ElementNotInteractableError(
        "The native element is disabled or has no usable on-screen bounds.",
      );
    }
    const { width: screenWidth, height: screenHeight } =
      await this.readScreenSize();
    if (centerX >= screenWidth || centerY >= screenHeight)
      throw new errors.ElementNotInteractableError(
        "The native element center is outside the screen.",
      );
    this.elements.clear();
    await this.client.act(action, { x: centerX, y: centerY, ...body });
  }

  async getText(elementId) {
    return (await this.resolveElement(elementId)).text;
  }

  async elementEnabled(elementId) {
    return (await this.resolveElement(elementId)).enabled;
  }

  async getElementRect(elementId) {
    return (await this.resolveElement(elementId)).rect;
  }

  async getAttribute(name, elementId) {
    if (
      typeof name !== "string" ||
      !Object.hasOwn(NATIVE_ATTRIBUTES[this.platformName], name)
    )
      throw new errors.UnsupportedOperationError(
        "This native attribute is not supported on the current platform.",
      );
    return (await this.resolveElement(elementId)).attributes[name];
  }

  async getContexts() {
    return ["NATIVE_APP"];
  }

  async getCurrentContext() {
    return "NATIVE_APP";
  }

  async setContext(name) {
    if (name !== "NATIVE_APP")
      throw new errors.UnsupportedOperationError(
        "Only NATIVE_APP is supported; Revyl has no WebView context transport.",
      );
  }

  async clear() {
    throw new errors.UnsupportedOperationError(
      "Clear requires a worker contract that verifies the editable target and empty result; coordinate-only native clear is not exposed.",
    );
  }

  async reset() {
    throw new errors.UnsupportedOperationError(
      "App reset is unsupported; the externally owned Revyl session will not be recreated or reset.",
    );
  }

  async readScreenSize() {
    let health;
    try {
      health = JSON.parse(
        (await this.client.worker("health")).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new errors.UnknownError(
          "Revyl returned invalid device geometry.",
        );
      throw error;
    }
    if (
      !health ||
      health.status !== "ok" ||
      health.device_connected !== true ||
      health.workflow_run_id !== this.client.workflowRunId ||
      typeof health.platform !== "string" ||
      health.platform.toLowerCase() !== this.platformName.toLowerCase() ||
      ![health.screen_width, health.screen_height].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 32768,
      )
    )
      throw new errors.UnknownError("Revyl returned invalid device geometry.");
    return { width: health.screen_width, height: health.screen_height };
  }

  async execute(script, args) {
    if (typeof script !== "string" || !Object.hasOwn(GESTURES, script))
      throw new errors.UnsupportedOperationError(
        "Only the documented revyl: native gesture commands are supported; JavaScript, mobile: commands, and arbitrary actions are unsupported.",
      );
    if (
      !Array.isArray(args) ||
      args.length !== 1 ||
      !args[0] ||
      typeof args[0] !== "object" ||
      Array.isArray(args[0])
    )
      throw new errors.InvalidArgumentError(
        "A native gesture requires exactly one options object.",
      );
    const options = args[0];
    const action = GESTURES[script];
    const timed = action === "longpress" || action === "swipe";
    const allowed = [
      "x",
      "y",
      ...(timed ? ["durationMs"] : []),
      ...(action === "swipe" ? ["direction"] : []),
    ];
    if (
      Object.keys(options).some((key) => !allowed.includes(key)) ||
      ![options.x, options.y].every(
        (value) => Number.isInteger(value) && value >= 0 && value < 32768,
      )
    )
      throw new errors.InvalidArgumentError(
        "Native gestures require integer x/y coordinates from 0 to 32767 and only their documented options.",
      );
    const body = { x: options.x, y: options.y };
    if (timed) {
      const durationMs =
        options.durationMs === undefined
          ? action === "longpress"
            ? 1500
            : 500
          : options.durationMs;
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10000)
        throw new errors.InvalidArgumentError(
          "Gesture durationMs must be an integer from 1 to 10000.",
        );
      body.duration_ms = durationMs;
    }
    if (action === "swipe") {
      if (!["up", "down", "left", "right"].includes(options.direction))
        throw new errors.InvalidArgumentError(
          "Swipe direction must be up, down, left, or right.",
        );
      body.direction = options.direction;
    }
    const { width, height } = await this.readScreenSize();
    if (body.x >= width || body.y >= height)
      throw new errors.InvalidArgumentError(
        "Gesture coordinates must be inside the native screen.",
      );
    if (
      action === "swipe" &&
      ((body.direction === "up" && body.y === 0) ||
        (body.direction === "down" && body.y === height - 1) ||
        (body.direction === "left" && body.x === 0) ||
        (body.direction === "right" && body.x === width - 1) ||
        Math.floor(
          (body.direction === "up" || body.direction === "down"
            ? height
            : width) / 4,
        ) === 0)
    )
      throw new errors.InvalidArgumentError(
        "The directional swipe has no usable travel within the screen.",
      );
    this.elements.clear();
    await this.client.act(action, body);
  }

  async getScreenshot() {
    const png = await this.client.worker("screenshot");
    if (
      png.length < 33 ||
      !png
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.readUInt32BE(8) !== 13 ||
      png.toString("ascii", 12, 16) !== "IHDR" ||
      png.readUInt32BE(16) < 1 ||
      png.readUInt32BE(20) < 1 ||
      png.readUInt32BE(16) * png.readUInt32BE(20) > 16000000
    ) {
      throw new errors.UnknownError(
        "Revyl returned an invalid PNG screenshot.",
      );
    }
    if (png[28] !== 0) {
      throw new errors.UnknownError(
        "Interlaced PNG screenshots are not supported.",
      );
    }
    try {
      PNG.sync.read(png, { checkCRC: true });
    } catch {
      throw new errors.UnknownError(
        "Revyl returned an invalid PNG screenshot.",
      );
    }
    return png.toString("base64");
  }

  async activateApp(bundleId, options = {}) {
    if (
      typeof bundleId !== "string" ||
      !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(bundleId) ||
      bundleId.length > 255 ||
      Object.keys(options).length
    ) {
      throw new errors.InvalidArgumentError(
        "activateApp requires a native bundle/package ID and supports no launch options.",
      );
    }
    this.elements.clear();
    await this.client.act("launch", { bundle_id: bundleId });
  }
}

module.exports = { RevylDriver };

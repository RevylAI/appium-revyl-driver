const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { BaseDriver, errors, W3C_ELEMENT_KEY } = require("appium/driver");
const { PNG } = require("pngjs");
const { RevylClient, UUID } = require("./client");
const { parseHierarchy } = require("./hierarchy");

const CAPABILITIES = new Set([
  "platformName",
  "automationName",
  "revylSessionId",
  "newCommandTimeout",
  "deviceName",
  "noReset",
  "fullReset",
]);

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
    this.locatorStrategies = ["accessibility id"];
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
    if (context)
      throw new errors.UnsupportedOperationError(
        "Element-scoped searches are not supported. Search from the driver.",
      );
    if (strategy !== "accessibility id")
      throw new errors.InvalidSelectorError(
        "Revyl supports accessibility id only.",
      );
    if (typeof selector !== "string" || !selector || selector.length > 1024) {
      throw new errors.InvalidSelectorError(
        "Accessibility ID must contain 1–1024 characters.",
      );
    }
    if (!Number.isFinite(this.implicitWaitMs) || this.implicitWaitMs > 120000) {
      throw new errors.InvalidArgumentError(
        "Revyl supports an implicit wait of at most 120000 ms.",
      );
    }
    const deadline = performance.now() + this.implicitWaitMs;
    do {
      const snapshot = await this.readHierarchy();
      const found = snapshot.elements.filter(
        (element) => element.identifier === selector,
      );
      if (found.length) {
        if (this.elements.size + found.length > 10000) {
          throw new errors.UnknownError(
            "Element-reference limit reached. Start a new Appium session.",
          );
        }
        const references = (multiple ? found : found.slice(0, 1)).map(
          (element) => {
            const id = randomUUID();
            this.elements.set(id, {
              ...element,
              fingerprint: snapshot.fingerprint,
            });
            return { [W3C_ELEMENT_KEY]: id };
          },
        );
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
      "No element has that accessibility ID.",
    );
  }

  async resolveElement(elementId) {
    const element = this.elements.get(elementId);
    if (
      !element ||
      element.fingerprint !== (await this.readHierarchy()).fingerprint
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
    const text =
      Array.isArray(value) && value.every((part) => typeof part === "string")
        ? value.join("")
        : value;
    if (
      typeof text !== "string" ||
      text.length > 10000 ||
      /[\uE000-\uF8FF]/u.test(text)
    ) {
      throw new errors.InvalidArgumentError(
        "sendKeys supports up to 10000 text characters, not WebDriver special keys.",
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

const { errors } = require("appium/driver");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

class RevylClient {
  constructor(appiumSessionId) {
    const apiKey = process.env.REVYL_API_KEY?.trim();
    if (!apiKey) {
      throw new errors.SessionNotCreatedError(
        "Set REVYL_API_KEY on the Appium server.",
      );
    }
    let baseUrl;
    try {
      baseUrl = new URL(
        process.env.REVYL_APPIUM_API_URL || "https://backend.revyl.ai",
      );
    } catch {
      throw new errors.SessionNotCreatedError(
        "REVYL_APPIUM_API_URL must be an HTTPS origin.",
      );
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      baseUrl.hostname,
    );
    if (
      (baseUrl.protocol !== "https:" &&
        !(loopback && baseUrl.protocol === "http:")) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      baseUrl.pathname !== "/"
    ) {
      throw new errors.SessionNotCreatedError(
        "REVYL_APPIUM_API_URL must be an HTTPS origin (HTTP is allowed only on loopback).",
      );
    }
    const timeoutMs = Number(
      process.env.REVYL_APPIUM_REQUEST_TIMEOUT_MS || 30000,
    );
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      throw new errors.SessionNotCreatedError(
        "REVYL_APPIUM_REQUEST_TIMEOUT_MS must be an integer from 1 to 120000.",
      );
    }
    this.baseUrl = baseUrl.origin;
    this.timeoutMs = timeoutMs;
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "appium-revyl-driver/0.1.0",
      "X-Revyl-Agent": "Appium",
      "X-Revyl-Agent-Session-Id": appiumSessionId,
    };
    this.abortController = new AbortController();
  }

  close() {
    this.abortController.abort();
    this.headers = {};
  }

  async request(path, body) {
    const signal = AbortSignal.any([
      this.abortController.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/execution/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal,
      });
    } catch {
      if (signal.aborted)
        throw new errors.TimeoutError(
          "Revyl request timed out or was cancelled. A timed-out action may have executed; it was not retried.",
        );
      throw new errors.UnknownError(
        "Revyl transport failed. Check connectivity; no driver retry was attempted.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new errors.UnknownError(
          "Revyl denied access. Check the server API key and session permissions.",
        );
      }
      if (response.status === 404 || response.status === 410) {
        throw new errors.NoSuchDriverError(
          "The Revyl session is unavailable or inaccessible.",
        );
      }
      if (response.status === 501) {
        throw new errors.UnsupportedOperationError(
          "This operation is not supported by the Revyl device.",
        );
      }
      throw new errors.UnknownError(
        `Revyl request failed (HTTP ${response.status}); no driver retry was attempted.`,
      );
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          throw new errors.UnknownError(
            "Revyl response exceeded the 16 MiB limit.",
          );
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (signal.aborted) {
        throw new errors.TimeoutError(
          "Revyl request timed out or was cancelled. A timed-out action may have executed; it was not retried.",
        );
      }
      if (error instanceof errors.UnknownError) {
        throw error;
      }
      throw new errors.UnknownError(
        "Revyl transport failed. Check connectivity; no driver retry was attempted.",
      );
    }
  }

  async attach(sessionId, platformName) {
    const response = await this.request(`device-sessions/${sessionId}`);
    let detail;
    try {
      detail = JSON.parse(response.toString());
    } catch {
      throw new errors.SessionNotCreatedError(
        "Revyl returned an invalid session response.",
      );
    }
    if (
      !detail ||
      detail.id !== sessionId ||
      detail.status !== "running" ||
      typeof detail.platform !== "string" ||
      detail.platform.toLowerCase() !== platformName.toLowerCase() ||
      typeof detail.workflow_run_id !== "string" ||
      !UUID.test(detail.workflow_run_id)
    ) {
      throw new errors.SessionNotCreatedError(
        "The Revyl session must be running, match platformName, and have a valid workflow run.",
      );
    }
    this.workflowRunId = detail.workflow_run_id;
  }

  async worker(action, body) {
    return this.request(`device-proxy/${this.workflowRunId}/${action}`, body);
  }

  async act(action, body) {
    const response = await this.worker(action, body);
    let result;
    try {
      result = JSON.parse(response.toString());
    } catch {
      throw new errors.UnknownError(
        `Revyl ${action} returned an invalid action result.`,
      );
    }
    if (result?.success !== true || result.action !== action || result.error) {
      throw new errors.UnknownError(
        `Revyl ${action} did not confirm success. Inspect the device-session action report; the action was not retried.`,
      );
    }
  }
}

module.exports = { RevylClient, UUID };

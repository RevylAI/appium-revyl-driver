# Revyl Appium driver (experimental)

Run a compatible native Appium test against an **existing, running Revyl device
session**. Your test connects to a local Appium server; this driver sends native
commands through Revyl's authenticated backend proxy. Neither Android SDK/ADB
nor a local Mac/Xcode installation is required for this driver.

This is an unpublished, attach-only prototype, not UiAutomator2 or XCUITest
compatibility. Local protocol tests use a real Appium server and client with a
mock Revyl backend; they do not prove real-device compatibility. Use the native
[device quickstart](https://docs.revyl.com/cli/device/quickstart) for the
currently supported device lifecycle.

This repository is self-contained: installation and local tests need no Revyl
monorepo checkout, private packages, cloud credentials, or device allocation.

## Install the source package

Use Node `^20.19.0`, `^22.12.0`, or `>=24` and npm 10 or newer. From this driver
directory, install dependencies **before** loading runtime credentials:

```bash
npm ci --ignore-scripts
npx --no-install appium driver install --source=local "$PWD"
```

There is no published npm release yet; `appium driver install revyl` is not an
available installation path. Use this source package until a release is
explicitly announced.

## Start the Appium server

Install and launch your app in a Revyl session using the
[device quickstart](https://docs.revyl.com/cli/device/quickstart), or attach to
one you already own. Creating a cloud session incurs usage; this driver never
creates, installs, resets, or stops one. Do not run another controller against
the same session while a test is running.

Provide `REVYL_API_KEY` to the **server process** through your secret manager or
CI environment, then start Appium:

```bash
npx --no-install appium --address 127.0.0.1 --port 4723 --log-level warn
```

Keep the server on loopback. Appium is not an authenticated public Revyl endpoint;
exposing it would grant callers your server credential's session access. Do not
put API keys in capabilities. Keep logs, typed data, and screenshots private;
Appium's debug logging can include command arguments.

The backend defaults to `https://backend.revyl.ai`. Operators can set
`REVYL_APPIUM_API_URL` to an HTTPS origin for their explicitly selected
environment; HTTP is permitted only for loopback tests. URLs with credentials,
paths, queries, or fragments are rejected. This setting cannot be supplied by
an Appium client. Requests have a 30-second timeout; the server-only
`REVYL_APPIUM_REQUEST_TIMEOUT_MS` accepts 1–120000 milliseconds. No request is
retried by the driver. A timeout is an uncertain outcome, not proof an action
didn't happen; inspect the session before repeating it. Existing worker-side
retry behavior is unchanged.

## Connect an existing test

Use your existing Appium client, change its server URL to
`http://127.0.0.1:4723`, and replace driver-specific capabilities with:

```json
{
  "platformName": "Android",
  "appium:automationName": "Revyl",
  "appium:revylSessionId": "YOUR_RUNNING_REVYL_SESSION_UUID",
  "appium:noReset": true
}
```

Use `"iOS"` for an iOS session. The platform must match the session, and the
backend still authorizes access on attachment and each proxied request.
`deviceName` is accepted as client metadata, not device selection;
`newCommandTimeout` controls Appium inactivity. `fullReset: false` is accepted.
Other capabilities, including `app`, `udid`, `bundleId`, `appPackage`,
`browserName`, and reset requests, are rejected rather than silently ignored.
Set implicit waits through the WebDriver timeout command, not a capability;
lookup waits are capped at 120 seconds.

### Supported commands

| Test operation                                    | Revyl mapping and limits                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create / quit Appium session                      | Verify the existing session and hierarchy / discard local references only.                                                                                                         |
| Find one or multiple elements by accessibility ID | Android `content-desc`; iOS IDB `AXUniqueId`. Exact matching, driver-level searches only.                                                                                          |
| Read text, enabled state, element rectangle       | Current native hierarchy. iOS text fields use `AXValue`; other iOS elements use `AXLabel`.                                                                                         |
| Click an element                                  | Recheck hierarchy, then tap its rectangle center. Android coordinates are pixels; iOS coordinates are points.                                                                      |
| Send text to an element                           | Recheck hierarchy, then native input with `clear_first: false`. Supported editable types are Android `android.widget.EditText` and iOS `TextField`, `SecureTextField`, `TextView`. |
| Screenshot                                        | PNG through the backend proxy, returned in standard WebDriver base64 form.                                                                                                         |
| Activate an installed app                         | Native `activate_app` endpoint with bundle/package ID and no options. No `mobile:` execute-script alias.                                                                           |

Screenshots must be non-interlaced PNGs of at most 16 megapixels. All backend
responses are limited to 16 MiB; decoding checks PNG integrity before returning
the image to the client.

XPath, resource IDs, predicates, class chains, nested element searches, clear,
visibility assertions, page source, browser/WebView contexts, gestures, W3C
actions, special keys, installation, reset, and arbitrary execute scripts are
unsupported. A test using these needs adaptation or its existing execution
environment. In JavaScript, use an append-text command such as WebdriverIO
`addValue`; `setValue` may call the unsupported clear command first.

Native input taps the field's center before typing with `clear_first: false`.
It does not clear existing content, but the tap can move the caret or change
the selection, so appending at the end is not guaranteed. Use an initially
empty field for the smoke example; caret-sensitive editing is outside this
prototype's verified contract.

### Element references are snapshot-scoped

Revyl's hierarchy API does not supply stable native element handles. References
expire on **any hierarchy change** and after a driver-issued tap, input, or app
launch, including an action that fails or times out. Find the element again
before another operation. An element is never relocated by its old coordinates
or silently rebound to another match.

This is deliberately stricter than standard native drivers. Dynamic labels,
animations, or background hierarchy updates may cause stale-element errors.
There is also a gap between rechecking the hierarchy and sending a coordinate
action; this adapter cannot make those operations atomic or prove visibility
and hit-testing. Use stable screens and no concurrent controllers. Do not use
this prototype for destructive flows.

### Python smoke example

In a separate environment, install `Appium-Python-Client`. The maintained
`examples/native_smoke.py` expects a fixture app exposing `name-input`,
`continue-button`, and `greeting` accessibility IDs. Entering `Revyl` and tapping
Continue must produce the exact text `Hello, Revyl!`. Adapt those locators and
the assertion to your own app; a screenshot alone isn't an assertion.

```bash
PLATFORM=android REVYL_SESSION_ID=YOUR_RUNNING_SESSION_UUID \
  python examples/native_smoke.py
```

Set `PLATFORM=ios` for iOS. This command interacts with a real session if the
server uses real credentials. It saves `artifacts/appium-android.png` or
`artifacts/appium-ios.png` with private permissions and always quits the Appium
session. **The owner must stop the Revyl session separately** when finished:

```bash
revyl device stop --session-id "$REVYL_SESSION_ID"
```

Only stop a session your job owns. Appium quit must not interrupt someone
else's allocation.

## Validation and rollout

From the repository root:

```bash
npm test
npm run check
npm pack --dry-run
```

Tests exercise actual Appium protocol dispatch and mock the backend boundary,
not the WebDriver server. A real Android and iOS session run with a real app and
assertions remains a release gate; nothing in the local suite allocates devices.

The intended customer outcome is less work to reuse native smoke tests; the
company outcome is more successful customer-controlled device usage. The primary
acceptance metric is the pass rate of the explicitly supported native smoke
flows. Guardrails are no silently successful unsupported commands, no driver
retries of uncertain actions, no unauthorized session control, no accidental
session teardown, and command latency. No real-device baseline is established.

Existing worker action reports receive the bounded `Appium` agent name and the
Appium session ID through the proxy's existing attribution headers. Their
before/after action records include success and latency, so reports can correlate
an Appium session's attempted and confirmed native operations without a second
telemetry stream. They do **not** measure driver discovery, attachment failures,
test assertions, or retention. Those product-funnel gaps and real-device results
must be addressed before treating this prototype as a released product feature.

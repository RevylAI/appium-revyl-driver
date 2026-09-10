# Revyl Appium driver

Run a supported subset of native Appium commands against an **existing Revyl
Android or iOS session**. This driver is not a drop-in replacement for
UiAutomator2 or XCUITest. The Python smoke sample has been verified against
synthetic apps on staging Android and iOS devices.

## Install

Use Node 24+ and npm 10+. Install before loading runtime credentials:

```bash
git clone https://github.com/RevylAI/appium-revyl-driver.git
cd appium-revyl-driver
npm ci --ignore-scripts
npx --no-install appium driver install --source=local "$PWD"
```

## Run

[Prepare a Revyl session](https://docs.revyl.ai/cli/device/quickstart) with your
app already installed and running. Provide `REVYL_API_KEY` through the Appium
server's environment, then start the server:

```bash
npx --no-install appium --address 127.0.0.1 --port 4723 --log-level warn
```

Keep the server on loopback and the key out of client capabilities. Connect
your Appium client to `http://127.0.0.1:4723` with:

```json
{
  "platformName": "Android",
  "appium:automationName": "Revyl",
  "appium:revylSessionId": "YOUR_RUNNING_SESSION_UUID",
  "appium:noReset": true
}
```

Use `"iOS"` for an iOS session. To run the [Python sample](examples/native_smoke.py),
install its client in your Python environment and use a second terminal:

```bash
python -m pip install Appium-Python-Client
PLATFORM=android REVYL_SESSION_ID=YOUR_RUNNING_SESSION_UUID \
  python examples/native_smoke.py
```

Use `PLATFORM=ios` for iOS. The sample expects an empty `name-input` field,
a `continue-button`, and a `greeting` with text `Hello, Revyl!` after submitting.
These are accessibility IDs; adapt the sample to your app. It saves a private
screenshot to `artifacts/appium-android.png` or `artifacts/appium-ios.png`.

## Native lookup and input

Supports text/enabled-state/rectangle reads, native attributes, taps, native text
input, screenshots, and activation of installed apps. These lookup strategies
work from the driver or within an element's descendants (excluding the element
itself):

| Strategy           | Android                                                  | iOS                                                               |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `accessibility id` | Exact `content-desc`                                     | Exact `AXUniqueId`                                                |
| `id`               | Exact full `resource-id`, with no package-name expansion | Unsupported                                                       |
| `class name`       | Native class, such as `android.widget.EditText`          | Raw IDB type, such as `TextField`, not `XCUIElementTypeTextField` |

Selectors contain 1–1024 characters. Duplicate matches return separate handles
in hierarchy order; a single-element lookup returns the first match. Handles
are invalidated on observed hierarchy changes or adapter mutations and are
never re-resolved by selector, including during an element-scoped implicit
wait. Find elements again after invalidation. A content fingerprint cannot
detect replacement nodes with identical serialized attributes or changes that
occur and revert between observations.

`getAttribute` exposes raw platform attributes as strings, or `null` when an
allowed attribute is absent:

- Android: `content-desc`, `resource-id`, `class`, `package`, `text`, `bounds`,
  `enabled`, `checked`, `checkable`, `clickable`, `focusable`, `focused`,
  `scrollable`, `long-clickable`, `password`, and `selected`.
- iOS: `AXUniqueId`, `AXLabel`, `AXValue`, `type`, and `enabled`.

Other attributes are unsupported; the driver does not infer displayedness,
selection, or focus when the hierarchy does not report them. Element taps and
input require a usable center inside the current native screen.

Text input accepts at most 10000 UTF-16 code units of well-formed Unicode.
Control characters (including newlines and tabs) and WebDriver special keys are
rejected before input. Input does not clear the field or guarantee appending;
use an empty field and `send_keys`/`addValue`, not a client helper that first
clears the element. The current worker may record input in its action report;
do not send credentials or other sensitive text through this driver.

## Native gestures and context

`getContexts` returns only `NATIVE_APP`; selecting it does not change the device.
The following execute commands are specific to this driver, not UiAutomator2 or
XCUITest `mobile:` contracts. Each takes exactly one options object:

```python
driver.execute_script("revyl:tap", {"x": 100, "y": 200})
driver.execute_script("revyl:doubleTap", {"x": 100, "y": 200})
driver.execute_script("revyl:longPress", {"x": 100, "y": 200, "durationMs": 1500})
driver.execute_script("revyl:swipe", {"x": 100, "y": 200, "direction": "up", "durationMs": 500})
```

Coordinates must be integers inside the native screen: Android pixels and iOS
points, not screenshot pixels. The driver bounds coordinates to 0–32767 and
validates current screen geometry through the authenticated backend.

- Tap and double-tap accept only `x` and `y`. Double-tap uses the worker's native
  two-tap gesture; it does not expose a configurable inter-tap interval.
- Long-press also accepts `durationMs` from 1–10000, defaulting to 1500.
- Swipe requires `direction`: `up`, `down`, `left`, or `right`. It moves a finger
  from `x,y` by one quarter of the screen dimension in that direction, clamped
  at the screen edge. A swipe with no travel is rejected. `durationMs` is
  1–10000, defaulting to 500; custom distances, percentages, and endpoints are
  unsupported.

Unknown options, command aliases, and `mobile:` commands are rejected rather
than ignored. The driver never retries an uncertain action; native worker
transports may still retry internally, so this is not an end-to-end exactly-once
guarantee. These additions have loopback protocol coverage, not new live-device
verification.

## Limits and cleanup

XPath, WebViews/DOM/JavaScript, W3C action sequences, drag, pinch, clear, install,
and reset remain unsupported. Clear is intentionally blocked: the coordinate
endpoint cannot verify a stable editable target and iOS does not confirm that
the field became empty. Matching a reusable accessibility/resource ID after the
operation cannot supply that missing worker guarantee. Install and reset need
separate owner-gated runtime contracts; they are never simulated by generic
worker forwarding, app restart, or device-session recreation.

Avoid destructive flows and concurrent controllers. Coordinate-based native
actions cannot eliminate a layout change between hierarchy lookup and input,
and snapshot handles cannot distinguish identical-looking replacement nodes.

`driver.quit()` detaches locally; it does **not** stop the Revyl session. When
finished, stop only a session you own:

```bash
revyl device stop --session-id YOUR_RUNNING_SESSION_UUID
```

# Revyl Appium driver

Run a supported subset of native Appium commands against an **existing Revyl
Android or iOS session**. Experimental; not a drop-in replacement for
UiAutomator2 or XCUITest. Live-device compatibility has not yet been verified.

## Install

Use Node 24+ and npm 10+. Install before loading runtime credentials:

```bash
git clone https://github.com/RevylAI/appium-revyl-driver.git
cd appium-revyl-driver
npm ci --ignore-scripts
npx --no-install appium driver install --source=local "$PWD"
```

## Run

[Prepare a Revyl session](https://docs.revyl.com/cli/device/quickstart) with your
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

## Limits and cleanup

Supports accessibility-ID lookup, text/enabled-state/rectangle reads, taps, native text
input, screenshots, and activation of installed apps. XPath, WebViews, gestures,
clear, install, and reset are unsupported. Find elements again after actions or
hierarchy changes. Text input does not clear the field or guarantee appending;
use an empty field. Avoid destructive flows and concurrent controllers.

`driver.quit()` detaches locally; it does **not** stop the Revyl session. When
finished, stop only a session you own:

```bash
revyl device stop --session-id YOUR_RUNNING_SESSION_UUID
```

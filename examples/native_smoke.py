import os
from pathlib import Path

from appium import webdriver
from appium.options.common import AppiumOptions
from appium.webdriver.client_config import AppiumClientConfig
from appium.webdriver.common.appiumby import AppiumBy
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support.ui import WebDriverWait


def greeting_is_correct(driver: WebDriver) -> bool:
    return (
        driver.find_element(AppiumBy.ACCESSIBILITY_ID, "greeting").text
        == "Hello, Revyl!"
    )


def main() -> None:
    platform = os.environ["PLATFORM"]
    if platform not in {"android", "ios"}:
        raise ValueError("PLATFORM must be android or ios")
    options = AppiumOptions().load_capabilities(
        {
            "platformName": "Android" if platform == "android" else "iOS",
            "appium:automationName": "Revyl",
            "appium:revylSessionId": os.environ["REVYL_SESSION_ID"],
            "appium:noReset": True,
        }
    )
    client_config = AppiumClientConfig(
        remote_server_addr="http://127.0.0.1:4723",
        timeout=60,
    )
    driver = webdriver.Remote(options=options, client_config=client_config)
    try:
        driver.implicitly_wait(5)
        driver.find_element(AppiumBy.ACCESSIBILITY_ID, "name-input").send_keys("Revyl")
        driver.find_element(AppiumBy.ACCESSIBILITY_ID, "continue-button").click()
        WebDriverWait(
            driver, 15, ignored_exceptions=(StaleElementReferenceException,)
        ).until(greeting_is_correct)
        artifact_dir = Path("artifacts")
        artifact_dir.mkdir(mode=0o700, exist_ok=True)
        screenshot_path = artifact_dir / f"appium-{platform}.png"
        with screenshot_path.open("wb") as screenshot_file:
            os.chmod(screenshot_path, 0o600)
            screenshot_file.write(driver.get_screenshot_as_png())
    finally:
        driver.quit()


if __name__ == "__main__":
    main()

import logging

from playwright.sync_api import BrowserContext, Page

from . import config

logger = logging.getLogger(__name__)


def is_logged_in(page: Page) -> bool:
    return page.locator('a[href="https://www.9tut.com/member/profile"]').count() > 0


def login(page: Page) -> None:
    if not config.USERNAME or not config.PASSWORD:
        raise RuntimeError(
            "CCNA_USERNAME / CCNA_PASSWORD not set. Create a .env file (see .env.example)."
        )

    page.goto(config.LOGIN_URL)
    page.get_by_role("textbox", name="Username/Email").fill(config.USERNAME)
    page.get_by_role("textbox", name="Password").fill(config.PASSWORD)
    page.get_by_role("button", name="Login").click()
    page.wait_for_load_state("networkidle")

    if not is_logged_in(page):
        raise RuntimeError("Login failed: profile link not found after submitting credentials.")

    logger.info("Logged in as %s", config.USERNAME)


def ensure_logged_in(context: BrowserContext) -> Page:
    page = context.new_page()
    page.goto(config.BASE_URL)
    if is_logged_in(page):
        logger.info("Restored existing session from saved state.")
        return page

    login(page)
    context.storage_state(path=str(config.AUTH_STATE_PATH))
    return page

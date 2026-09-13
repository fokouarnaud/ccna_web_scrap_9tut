import argparse
import json
import logging
import time

from playwright.sync_api import sync_playwright

from . import auth, config, link_discovery, parser

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def _load_existing(path) -> dict:
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return {p["url"]: p for p in json.load(f)}
    return {}


def _save(path, pages_by_url: dict) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(list(pages_by_url.values()), f, indent=2, ensure_ascii=False)


def build_target_list() -> list:
    """Returns list of {category, section, title, url}."""
    targets = []
    seen = set()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = (
            browser.new_context(storage_state=str(config.AUTH_STATE_PATH))
            if config.AUTH_STATE_PATH.exists()
            else browser.new_context()
        )
        page = auth.ensure_logged_in(context)
        links = link_discovery.discover_all_links(page)
        browser.close()

    for item in links["category"]:
        if item["url"] not in seen:
            seen.add(item["url"])
            targets.append({"category": "CCNA 200-301", "section": item["section"], "title": item["title"], "url": item["url"]})

    for item in links["premium"]:
        if item["url"] not in seen:
            seen.add(item["url"])
            targets.append({"category": "Premium Member Zone", "section": item["section"], "title": item["title"], "url": item["url"]})

    return targets


def scrape(targets: list, limit: int | None, force: bool) -> None:
    questions_by_url = {} if force else _load_existing(config.QUESTIONS_FILE)
    generic_by_url = {} if force else _load_existing(config.LAB_SIMS_FILE)

    pending = [t for t in targets if t["url"] not in questions_by_url and t["url"] not in generic_by_url]
    if limit is not None:
        pending = pending[:limit]

    logger.info("%d pages to scrape (of %d total targets)", len(pending), len(targets))
    if not pending:
        return

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = (
            browser.new_context(storage_state=str(config.AUTH_STATE_PATH))
            if config.AUTH_STATE_PATH.exists()
            else browser.new_context()
        )
        page = auth.ensure_logged_in(context)

        for i, target in enumerate(pending, start=1):
            url = target["url"]
            logger.info("[%d/%d] %s", i, len(pending), url)
            try:
                page.goto(url, wait_until="networkidle")
                html = page.content()
            except Exception:
                logger.exception("Failed to load %s, skipping", url)
                continue

            parsed = parser.parse_page(html, url)
            record = parsed.to_dict()
            record["category"] = target["category"]
            record["section"] = target["section"]

            if isinstance(parsed, parser.PageContent):
                questions_by_url[url] = record
            else:
                generic_by_url[url] = record

            time.sleep(config.REQUEST_DELAY_SECONDS)

        browser.close()

    _save(config.QUESTIONS_FILE, questions_by_url)
    _save(config.LAB_SIMS_FILE, generic_by_url)
    logger.info(
        "Saved %d Q&A pages to %s, %d generic pages to %s",
        len(questions_by_url), config.QUESTIONS_FILE, len(generic_by_url), config.LAB_SIMS_FILE,
    )


def main() -> None:
    parser_args = argparse.ArgumentParser(description="Scrape CCNA 200-301 content from 9tut.com")
    parser_args.add_argument("--limit", type=int, default=None, help="Only scrape the first N pending pages")
    parser_args.add_argument("--force", action="store_true", help="Re-scrape pages already present in the output files")
    args = parser_args.parse_args()

    targets = build_target_list()
    logger.info("Discovered %d target pages", len(targets))
    scrape(targets, limit=args.limit, force=args.force)


if __name__ == "__main__":
    main()

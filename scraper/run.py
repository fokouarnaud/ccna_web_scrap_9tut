import argparse
import json
import logging
import re
import time

from playwright.sync_api import sync_playwright

from . import auth, config, download_images, link_discovery, parser

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

CHECKPOINT_EVERY = 20
PAGE_NUMBER_RE = re.compile(r"^\d+$")


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

    for item in links["training"]:
        if item["url"] not in seen:
            seen.add(item["url"])
            targets.append({"category": "CCNA Training", "section": item["section"], "title": item["title"], "url": item["url"]})

    return targets


def _pagination_urls(page_url: str, links: list) -> list:
    """Some long CCNA Training tutorials (OSPF, Subnetting, VLAN, ACLs, ...)
    are split across a "1 2 3" pager (.../tutorial, .../tutorial/2, ...).
    Detects those continuation links so their content can be merged in."""
    return [link["url"] for link in links if PAGE_NUMBER_RE.match(link["text"]) and link["url"] == f"{page_url}/{link['text']}"]


def _follow_pagination(first: "parser.GenericPage", browser_page, url: str) -> "parser.GenericPage":
    fetched = {url}
    texts = [first.text]
    images = list(first.images)
    all_links = list(first.links)
    pending = _pagination_urls(url, first.links)

    while pending:
        extra_url = pending.pop(0)
        if extra_url in fetched:
            continue
        fetched.add(extra_url)
        logger.info("  -> pagination: %s", extra_url)
        try:
            browser_page.goto(extra_url, wait_until="networkidle")
            html = browser_page.content()
        except Exception:
            logger.exception("Failed to load pagination page %s, skipping", extra_url)
            continue
        sub = parser.parse_generic_page(html, extra_url)
        if sub.text:
            texts.append(sub.text)
        images.extend(sub.images)
        all_links.extend(sub.links)
        pending.extend(u for u in _pagination_urls(url, sub.links) if u not in fetched)
        time.sleep(config.REQUEST_DELAY_SECONDS)

    if len(fetched) == 1:
        return first

    pagination_urls = fetched - {url}
    seen_links = set()
    merged_links = []
    for link in all_links:
        if link["url"] in pagination_urls or link["url"] == url or link["url"] in seen_links:
            continue
        seen_links.add(link["url"])
        merged_links.append(link)

    seen_images = set()
    merged_images = []
    for img in images:
        if img not in seen_images:
            seen_images.add(img)
            merged_images.append(img)

    return parser.GenericPage(
        url=first.url,
        title=first.title,
        text="\n\n".join(t for t in texts if t),
        images=merged_images,
        links=merged_links,
    )


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
            if isinstance(parsed, parser.GenericPage) and target["category"] == "CCNA Training":
                parsed = _follow_pagination(parsed, page, url)
            record = parsed.to_dict()
            record["category"] = target["category"]
            record["section"] = target["section"]

            if isinstance(parsed, parser.PageContent):
                questions_by_url[url] = record
            else:
                generic_by_url[url] = record

            if i % CHECKPOINT_EVERY == 0:
                # Checkpoint so a long run (hundreds of pages) doesn't lose
                # everything to a crash/interruption near the end: a re-run
                # without --force resumes from here (already-saved URLs are
                # skipped via _load_existing above).
                _save(config.QUESTIONS_FILE, questions_by_url)
                _save(config.LAB_SIMS_FILE, generic_by_url)
                logger.info("Checkpoint saved at %d/%d", i, len(pending))

            time.sleep(config.REQUEST_DELAY_SECONDS)

        browser.close()

    _save(config.QUESTIONS_FILE, questions_by_url)
    _save(config.LAB_SIMS_FILE, generic_by_url)
    logger.info(
        "Saved %d Q&A pages to %s, %d generic pages to %s",
        len(questions_by_url), config.QUESTIONS_FILE, len(generic_by_url), config.LAB_SIMS_FILE,
    )

    logger.info("Downloading referenced images...")
    download_images.download_all()


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

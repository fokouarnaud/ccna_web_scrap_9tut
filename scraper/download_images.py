"""Download every image referenced by data/ccna_questions.json and
data/lab_sims.json into review_app/images/, then rewrite those JSON files so
questions/pages point at the local copy instead of hotlinking 9tut.com.

Rationale: hotlinking a third-party site is fragile (it can go down, change
its layout, or start blocking hotlinks) and slow (extra DNS/TLS round trips
per image). Owning the assets makes the app self-contained and faster.

Idempotent: images already present on disk are not re-downloaded, and a URL
that fails to download is left pointing at the original remote URL (instead
of breaking the reference) so a later re-run can retry it.

Usage: python -m scraper.download_images
(also run automatically at the end of `python -m scraper.run`)
"""

import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from . import config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

DOWNLOAD_DELAY_SECONDS = 0.3
USER_AGENT = "Mozilla/5.0 (compatible; ccna-review-app-scraper/1.0)"


def _local_paths_for(url: str) -> tuple[Path, str]:
    """Returns (filesystem path, served URL) for a remote image URL."""
    parsed = urlparse(url)
    host_dir = parsed.netloc.lower().removeprefix("www.")
    rel_path = parsed.path.lstrip("/")
    disk_path = config.IMAGES_DIR / host_dir / rel_path
    served_url = f"{config.IMAGES_URL_PREFIX}/{host_dir}/{rel_path}"
    return disk_path, served_url


def _collect_image_urls(qa_pages: list, generic_pages: list) -> set:
    urls = set()
    for page in qa_pages:
        urls.update(page.get("images", []))  # page-level (e.g. a "Quick Summary" intro diagram)
        for q in page.get("questions", []):
            urls.update(q.get("images", []))
    for page in generic_pages:
        urls.update(page.get("images", []))
    # A previous run already rewrote some of these to local paths (e.g.
    # "/images/9tut.com/..."); only remote URLs need (re-)downloading.
    return {u for u in urls if u.startswith("http://") or u.startswith("https://")}


def _download_one(url: str) -> bool:
    disk_path, _ = _local_paths_for(url)
    if disk_path.exists() and disk_path.stat().st_size > 0:
        return True
    disk_path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        logger.warning("Failed to download %s: %s", url, exc)
        return False
    disk_path.write_bytes(data)
    return True


def download_all() -> dict:
    qa_pages = json.loads(config.QUESTIONS_FILE.read_text(encoding="utf-8")) if config.QUESTIONS_FILE.exists() else []
    generic_pages = json.loads(config.LAB_SIMS_FILE.read_text(encoding="utf-8")) if config.LAB_SIMS_FILE.exists() else []

    urls = sorted(_collect_image_urls(qa_pages, generic_pages))
    logger.info("%d unique image URLs referenced", len(urls))

    url_map = {}
    downloaded = 0
    failed = 0
    for i, url in enumerate(urls, start=1):
        disk_path, served_url = _local_paths_for(url)
        already_present = disk_path.exists() and disk_path.stat().st_size > 0
        ok = _download_one(url)
        if ok:
            url_map[url] = served_url
            if not already_present:
                downloaded += 1
                logger.info("[%d/%d] downloaded %s", i, len(urls), url)
                time.sleep(DOWNLOAD_DELAY_SECONDS)
        else:
            failed += 1

    def _remap(images: list) -> list:
        return [url_map.get(src, src) for src in images]

    for page in qa_pages:
        if page.get("images"):
            page["images"] = _remap(page["images"])
        for q in page.get("questions", []):
            if q.get("images"):
                q["images"] = _remap(q["images"])
    for page in generic_pages:
        if page.get("images"):
            page["images"] = _remap(page["images"])

    config.QUESTIONS_FILE.write_text(json.dumps(qa_pages, indent=2, ensure_ascii=False), encoding="utf-8")
    config.LAB_SIMS_FILE.write_text(json.dumps(generic_pages, indent=2, ensure_ascii=False), encoding="utf-8")

    logger.info("Downloaded %d new images, %d already present, %d failed", downloaded, len(url_map) - downloaded, failed)
    return {"total": len(urls), "downloaded": downloaded, "failed": failed}


if __name__ == "__main__":
    result = download_all()
    print(f"{result['total']} images referenced, {result['downloaded']} newly downloaded, {result['failed']} failed")

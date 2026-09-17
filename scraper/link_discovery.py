import logging

from playwright.sync_api import Page

from . import config

logger = logging.getLogger(__name__)

_JS_COLLECT_SECTION_LINKS = """
(headingText) => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const heading = headings.find(h => h.textContent.trim() === headingText);
    if (!heading) return [];

    // The sidebar heading's links live in the <ul> list(s) that follow it,
    // inside the same parent block (see structure explored on 9tut.com).
    const container = heading.parentElement;
    const items = Array.from(container.querySelectorAll('ul > li'));

    const results = [];
    let currentSection = null;
    for (const li of items) {
        const link = li.querySelector('a');
        if (!link) {
            // Marker/separator line, e.g. "=== New CCNA v1.1 Lab Sims ==="
            currentSection = li.textContent.trim();
            continue;
        }
        results.push({
            section: currentSection,
            title: link.textContent.trim(),
            url: link.href,
        });
    }
    return results;
}
"""


def get_category_links(page: Page) -> list[dict]:
    """Links under the 'CCNA 200-301' sidebar heading."""
    links = page.evaluate(_JS_COLLECT_SECTION_LINKS, "CCNA 200-301")
    logger.info("Found %d links under 'CCNA 200-301'", len(links))
    return links


def get_premium_zone_links(page: Page) -> list[dict]:
    """Links under the 'Premium Member Zone' sidebar heading (New Questions
    Parts, Composite Quizzes, Lab Sims). Only visible when logged in."""
    links = page.evaluate(_JS_COLLECT_SECTION_LINKS, "Premium Member Zone")
    logger.info("Found %d links under 'Premium Member Zone'", len(links))
    return links


def get_training_links(page: Page) -> list[dict]:
    """Links under the 'CCNA Training' sidebar heading — topic tutorials
    (Subnetting, VLAN, OSPF, ACLs, ...) that question explanations and page
    intros link back to (e.g. "please read our VLAN Tutorial")."""
    links = page.evaluate(_JS_COLLECT_SECTION_LINKS, "CCNA Training")
    logger.info("Found %d links under 'CCNA Training'", len(links))
    return links


def discover_all_links(page: Page) -> dict:
    page.goto(config.BASE_URL)
    page.wait_for_load_state("networkidle")
    return {
        "category": get_category_links(page),
        "premium": get_premium_zone_links(page),
        "training": get_training_links(page),
    }

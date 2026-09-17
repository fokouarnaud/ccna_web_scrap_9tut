import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, NavigableString, Tag

INTERNAL_HOSTS = {"www.9tut.com", "9tut.com"}

CHOICE_LINE_RE = re.compile(r"^([A-Z])\.\s*(.*)$")
CHOICES_PARAGRAPH_RE = re.compile(r"^[A-Z]\.\s")
ANSWER_LETTERS_RE = re.compile(r"[A-Z]")
CHOOSE_N_RE = re.compile(r"choose\s+(two|three|four)", re.IGNORECASE)


@dataclass
class Question:
    number: int
    text: str
    choices: list
    answer: list
    multi_answer: bool
    explanation: str
    reference: str | None
    images: list = field(default_factory=list)
    links: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "number": self.number,
            "text": self.text,
            "choices": self.choices,
            "answer": self.answer,
            "multi_answer": self.multi_answer,
            "explanation": self.explanation,
            "reference": self.reference,
            "images": self.images,
            "links": self.links,
        }


@dataclass
class PageContent:
    url: str
    title: str
    intro: str
    questions: list
    images: list = field(default_factory=list)
    links: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "intro": self.intro,
            "questions": [q.to_dict() for q in self.questions],
            "images": self.images,
            "links": self.links,
        }


@dataclass
class GenericPage:
    url: str
    title: str
    text: str
    images: list
    links: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "text": self.text,
            "images": self.images,
            "links": self.links,
        }


def _clean_text(text: str) -> str:
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _node_text(node) -> str:
    if isinstance(node, NavigableString):
        return str(node)
    return node.get_text(separator=" ")


def _marker_tag(node) -> Tag | None:
    """The element carrying the "Question N" marker class — usually a <span>
    nested in a <p>, but on some pages (e.g. the first couple of questions on
    a "Quick Summary" page) the class sits directly on the <p> itself with no
    inner <span>. Missing that second form silently drops those questions
    into the page intro instead of their own block."""
    if not isinstance(node, Tag):
        return None
    if "ccnaquestionsnumber" in (node.get("class") or []):
        return node
    return node.find("span", class_="ccnaquestionsnumber")


def _is_marker(node) -> bool:
    return _marker_tag(node) is not None


def _is_blank_paragraph(node) -> bool:
    """True for a genuinely empty <p> (e.g. "&nbsp;" spacers) — NOT for a <p>
    that only wraps an <img>, which also has empty get_text() but must still
    reach the image-extraction step in the explanation loop below."""
    return (
        isinstance(node, Tag)
        and node.name == "p"
        and _clean_text(node.get_text()) == ""
        and node.find("img") is None
    )


def _paragraph_starts_with_choice(node) -> bool:
    """True if this <p> begins with 'A.'/'B.'/... — either a whole choices
    block (format 1: "A. .. B. .. C. ..") or a single choice of a run where
    each option gets its own <p> (format 2, common for multi-line CLI config
    choices)."""
    if not (isinstance(node, Tag) and node.name == "p"):
        return False
    text = _clean_text(node.get_text(separator="\n"))
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    return bool(lines) and bool(CHOICE_LINE_RE.match(lines[0]))


def _is_answer_paragraph(node) -> bool:
    return isinstance(node, Tag) and node.find("span", class_="ccnacorrectanswers") is not None


def _is_explanation_marker(node) -> bool:
    return isinstance(node, Tag) and node.find("span", class_="ccnaexplanation") is not None


def _is_reference_paragraph(node) -> bool:
    return isinstance(node, Tag) and node.name == "p" and _clean_text(node.get_text()).startswith("Reference:")


def _extract_images(node) -> list:
    if not isinstance(node, Tag):
        return []
    return [img.get("src") for img in node.find_all("img") if img.get("src")]


def _extract_images_from_nodes(nodes) -> list:
    images = []
    for node in nodes:
        images.extend(_extract_images(node))
    return images


def _is_internal_link(absolute_url: str) -> bool:
    try:
        return urlparse(absolute_url).netloc.lower() in INTERNAL_HOSTS
    except ValueError:
        return False


def _extract_links(node, base_url: str) -> list:
    """Anchors pointing back into 9tut.com (e.g. "read our VLAN Tutorial"
    inside a page intro or a question's explanation) — the only links worth
    keeping, since they point at pages we scrape and can link to internally."""
    if not isinstance(node, Tag):
        return []
    links = []
    for a in node.find_all("a"):
        href = a.get("href")
        text = _clean_text(a.get_text())
        if not href or not text:
            continue
        absolute = urljoin(base_url, href)
        if _is_internal_link(absolute):
            links.append({"text": text, "url": absolute})
    return links


def _extract_links_from_nodes(nodes, base_url: str) -> list:
    links = []
    for node in nodes:
        links.extend(_extract_links(node, base_url))
    return links


def _dedup_links(links: list) -> list:
    seen = set()
    result = []
    for link in links:
        if link["url"] in seen:
            continue
        seen.add(link["url"])
        result.append(link)
    return result


def _parse_choices(node) -> list:
    text = _clean_text(node.get_text(separator="\n"))
    choices = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        match = CHOICE_LINE_RE.match(line)
        if match:
            choices.append({"letter": match.group(1), "text": match.group(2).strip()})
        elif choices:
            # Continuation of a multi-line choice (e.g. CLI config block).
            choices[-1]["text"] += "\n" + line
    return choices


def _parse_answer(node) -> list:
    span = node.find("span", class_="ccnacorrectanswers")
    after = span.next_sibling
    answer_text = ""
    while after is not None:
        answer_text += _node_text(after)
        after = after.next_sibling
    return ANSWER_LETTERS_RE.findall(answer_text.strip())


def _find_content_div(soup: BeautifulSoup) -> Tag | None:
    post = soup.select_one("div.post")
    if post is None:
        return None
    return post.select_one("div.content") or post


def _page_title(soup: BeautifulSoup, post: Tag | None, url: str) -> str:
    """Most pages have an <h1>; a few (topic/archive index pages) don't, so
    fall back to the <title> tag, e.g. "CCNA Training » CCNA Knowledge"."""
    title_tag = post.find("h1") if post else None
    if title_tag:
        return _clean_text(title_tag.get_text())
    head_title = soup.find("title")
    if head_title:
        text = _clean_text(head_title.get_text())
        return text.split("»")[-1].strip() or text
    return url


def parse_question_page(html: str, url: str) -> PageContent | None:
    soup = BeautifulSoup(html, "html.parser")
    post = soup.select_one("div.post")
    content = _find_content_div(soup)
    if content is None:
        return None

    if not content.select("p.ccnaquestionsnumber, span.ccnaquestionsnumber"):
        return None

    title = _page_title(soup, post, url)

    nodes = list(content.contents)
    marker_indices = [i for i, n in enumerate(nodes) if _is_marker(n)]

    intro_nodes = nodes[: marker_indices[0]]
    intro = _clean_text("".join(_node_text(n) for n in intro_nodes))
    intro_links = _dedup_links(_extract_links_from_nodes(intro_nodes, url))
    intro_images = _extract_images_from_nodes(intro_nodes)

    questions = []
    for idx, start in enumerate(marker_indices):
        end = marker_indices[idx + 1] if idx + 1 < len(marker_indices) else len(nodes)
        block = nodes[start:end]

        marker_node = block[0]
        number_text = _marker_tag(marker_node).get_text()
        number_match = re.search(r"\d+", number_text)
        number = int(number_match.group()) if number_match else idx + 1

        rest = block[1:]

        choices_idx = next((i for i, n in enumerate(rest) if _paragraph_starts_with_choice(n)), None)
        if choices_idx is None:
            question_text = _clean_text("".join(_node_text(n) for n in rest))
            choices = []
            answer = []
            explanation_parts = []
            reference = None
            images = _extract_images_from_nodes(rest)
            links = _dedup_links(_extract_links_from_nodes(rest, url))
            questions.append(
                Question(
                    number=number,
                    text=question_text,
                    choices=choices,
                    answer=answer,
                    multi_answer=bool(CHOOSE_N_RE.search(question_text)),
                    explanation=_clean_text(" ".join(explanation_parts)),
                    reference=reference,
                    images=images,
                    links=links,
                )
            )
            continue

        question_text = _clean_text("".join(_node_text(n) for n in rest[:choices_idx]))

        # Choices may be packed into a single <p> ("A. .. B. .. C. ..") or spread
        # one-per-<p> (common for multi-line CLI config choices) — collect the
        # whole contiguous run either way.
        run_end = choices_idx
        while run_end < len(rest):
            node = rest[run_end]
            if _paragraph_starts_with_choice(node):
                run_end += 1
                continue
            if isinstance(node, NavigableString) and not _clean_text(str(node)):
                # Whitespace-only text node between sibling <p> choices; skip
                # over it without breaking the run.
                run_end += 1
                continue
            break
        choice_nodes = [n for n in rest[choices_idx:run_end] if _paragraph_starts_with_choice(n)]

        choices = []
        # Diagrams (e.g. "Refer to the exhibit") sit in the question stem,
        # before the choices — collect those images/links first.
        images = _extract_images_from_nodes(rest[:choices_idx])
        links = _extract_links_from_nodes(rest[:choices_idx], url)
        for node in choice_nodes:
            choices.extend(_parse_choices(node))
            images.extend(_extract_images(node))
            links.extend(_extract_links(node, url))

        after_choices = rest[run_end:]
        answer_idx = next((i for i, n in enumerate(after_choices) if _is_answer_paragraph(n)), None)

        answer = []
        explanation_parts = []
        reference = None

        if answer_idx is not None:
            answer = _parse_answer(after_choices[answer_idx])
            tail = after_choices[answer_idx + 1 :]

            in_explanation = False
            for node in tail:
                if _is_blank_paragraph(node):
                    continue
                if _is_explanation_marker(node):
                    in_explanation = True
                    continue
                if _is_reference_paragraph(node):
                    link = node.find("a")
                    reference = link.get("href") if link else _clean_text(node.get_text())
                    continue
                images.extend(_extract_images(node))
                links.extend(_extract_links(node, url))
                if in_explanation and isinstance(node, Tag) and node.name in ("p", "div", "pre"):
                    text = _clean_text(node.get_text())
                    if text:
                        explanation_parts.append(text)
        else:
            images.extend(_extract_images_from_nodes(after_choices))
            links.extend(_extract_links_from_nodes(after_choices, url))

        questions.append(
            Question(
                number=number,
                text=question_text,
                choices=choices,
                answer=answer,
                multi_answer=bool(CHOOSE_N_RE.search(question_text)),
                explanation=_clean_text(" ".join(explanation_parts)),
                reference=reference,
                images=images,
                links=_dedup_links(links),
            )
        )

    return PageContent(url=url, title=title, intro=intro, questions=questions, images=intro_images, links=intro_links)


def parse_generic_page(html: str, url: str) -> GenericPage:
    soup = BeautifulSoup(html, "html.parser")
    post = soup.select_one("div.post")
    content = _find_content_div(soup)

    title = _page_title(soup, post, url)

    if content is None:
        return GenericPage(url=url, title=title, text="", images=[])

    paragraphs = [
        _clean_text(p.get_text())
        for p in content.find_all("p")
        if _clean_text(p.get_text())
    ]
    images = [img.get("src") for img in content.find_all("img") if img.get("src")]
    links = _dedup_links(_extract_links(content, url))

    return GenericPage(url=url, title=title, text="\n\n".join(paragraphs), images=images, links=links)


def parse_page(html: str, url: str):
    """Try the Q&A parser first; fall back to generic content extraction."""
    page = parse_question_page(html, url)
    if page is not None and page.questions:
        return page
    return parse_generic_page(html, url)

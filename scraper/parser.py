import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, NavigableString, Tag

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
        }


@dataclass
class PageContent:
    url: str
    title: str
    intro: str
    questions: list

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "intro": self.intro,
            "questions": [q.to_dict() for q in self.questions],
        }


@dataclass
class GenericPage:
    url: str
    title: str
    text: str
    images: list

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "text": self.text,
            "images": self.images,
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


def _is_marker(node) -> bool:
    return isinstance(node, Tag) and node.find("span", class_="ccnaquestionsnumber") is not None


def _is_blank_paragraph(node) -> bool:
    return isinstance(node, Tag) and node.name == "p" and _clean_text(node.get_text()) == ""


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


def parse_question_page(html: str, url: str) -> PageContent | None:
    soup = BeautifulSoup(html, "html.parser")
    post = soup.select_one("div.post")
    content = _find_content_div(soup)
    if content is None:
        return None

    markers = content.find_all("span", class_="ccnaquestionsnumber")
    if not markers:
        return None

    title_tag = post.find("h1") if post else None
    title = _clean_text(title_tag.get_text()) if title_tag else url

    nodes = list(content.contents)
    marker_indices = [i for i, n in enumerate(nodes) if _is_marker(n)]

    intro_nodes = nodes[: marker_indices[0]]
    intro = _clean_text("".join(_node_text(n) for n in intro_nodes))

    questions = []
    for idx, start in enumerate(marker_indices):
        end = marker_indices[idx + 1] if idx + 1 < len(marker_indices) else len(nodes)
        block = nodes[start:end]

        marker_node = block[0]
        number_text = marker_node.find("span", class_="ccnaquestionsnumber").get_text()
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
            images = []
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
        images = []
        for node in choice_nodes:
            choices.extend(_parse_choices(node))
            images.extend(_extract_images(node))

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
                if in_explanation and isinstance(node, Tag) and node.name in ("p", "div", "pre"):
                    text = _clean_text(node.get_text())
                    if text:
                        explanation_parts.append(text)

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
            )
        )

    return PageContent(url=url, title=title, intro=intro, questions=questions)


def parse_generic_page(html: str, url: str) -> GenericPage:
    soup = BeautifulSoup(html, "html.parser")
    post = soup.select_one("div.post")
    content = _find_content_div(soup)

    title_tag = post.find("h1") if post else None
    title = _clean_text(title_tag.get_text()) if title_tag else url

    if content is None:
        return GenericPage(url=url, title=title, text="", images=[])

    paragraphs = [
        _clean_text(p.get_text())
        for p in content.find_all("p")
        if _clean_text(p.get_text())
    ]
    images = [img.get("src") for img in content.find_all("img") if img.get("src")]

    return GenericPage(url=url, title=title, text="\n\n".join(paragraphs), images=images)


def parse_page(html: str, url: str):
    """Try the Q&A parser first; fall back to generic content extraction."""
    page = parse_question_page(html, url)
    if page is not None and page.questions:
        return page
    return parse_generic_page(html, url)

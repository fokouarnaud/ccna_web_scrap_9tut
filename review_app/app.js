const EXAM_PASS_PCT = 82; // rough equivalent of the ~825/1000 passing score mentioned in the CCNA FAQ
const EXAM_DEFAULT_CATEGORY = "CCNA 200-301";
const EXAM_SECONDS_PER_QUESTION = 120; // 2 min/question, derived from the 60q/120min real exam pace
const EXAM_SLOW_FACTOR = 1.5; // a question taking > 1.5x the average time counts as "slow"
const EXAM_MAX_MINUTES = 120;

const state = {
  user: null, // {username, email, display_name}
  pages: [], // all Q&A pages
  genericPages: [], // lab sims / tutorial-style pages
  questions: [], // flattened, each with pageRef
  flagged: new Set(),
  seen: new Set(),
  quizStats: {}, // category -> {correct, total}
  examHistory: [], // past exam attempts
  currentView: { type: "page", pageUrl: null }, // page | flagged | quiz | generic | exam-setup | exam | exam-results | account
  globalAnswersHidden: true,
  quiz: null, // active quiz session state
  exam: null, // active/finished exam session state
  examTimerHandle: null,
};

function questionId(pageUrl, number) {
  return `${pageUrl}::${number}`;
}

async function loadData() {
  const [qaPages, genericPages] = await Promise.all([Api.getQuestions(), Api.getLabSims()]);
  state.pages = qaPages;
  state.genericPages = genericPages;

  state.questions = [];
  for (const page of state.pages) {
    for (const q of page.questions) {
      state.questions.push({
        ...q,
        id: questionId(page.url, q.number),
        pageUrl: page.url,
        pageTitle: page.title,
        category: page.category,
        section: page.section,
      });
    }
  }
}

async function loadProgress() {
  const progress = await Api.getProgress();
  state.seen = new Set(progress.seen || []);
  state.flagged = new Set(progress.flagged || []);
  state.quizStats = progress.quizStats || {};
  state.examHistory = progress.examHistory || [];
}

function buildSidebar() {
  const sidebar = document.getElementById("nav-content");
  sidebar.innerHTML = "";

  const specialSection = document.createElement("div");
  specialSection.className = "nav-section";
  specialSection.innerHTML = `<h2>Révision</h2>`;
  const flaggedItem = navItem(`⭐ Questions difficiles`, state.flagged.size, () => setView({ type: "flagged" }));
  const quizItem = navItem(`🎯 Mode Quiz`, "", () => setView({ type: "quiz-setup" }));
  const examItem = navItem(`🎓 Mode Examen`, "", () => setView({ type: "exam-setup" }));
  const difficultCount = state.questions.filter((q) => state.flagged.has(q.id) && q.choices.length && q.answer.length).length;
  const examDifficultItem = navItem(`🩹 Examen questions difficiles`, difficultCount, () => setView({ type: "exam-setup", difficultOnly: true }));
  specialSection.appendChild(flaggedItem);
  specialSection.appendChild(quizItem);
  specialSection.appendChild(examItem);
  specialSection.appendChild(examDifficultItem);
  sidebar.appendChild(specialSection);

  const byCategory = groupBy(state.pages, (p) => p.category);
  for (const [category, pages] of byCategory) {
    const section = document.createElement("div");
    section.className = "nav-section";
    section.innerHTML = `<h2>${escapeHtml(category)}</h2>`;
    for (const page of pages) {
      const seenCount = page.questions.filter((q) => state.seen.has(questionId(page.url, q.number))).length;
      const label = page.section ? `${page.title}` : page.title;
      const item = navItem(label, `${seenCount}/${page.questions.length}`, () => setView({ type: "page", pageUrl: page.url }));
      item.dataset.url = page.url;
      section.appendChild(item);
    }
    sidebar.appendChild(section);
  }

  if (state.genericPages.length) {
    const section = document.createElement("div");
    section.className = "nav-section";
    section.innerHTML = `<h2>Lab Sims &amp; Tutoriels</h2>`;
    for (const page of state.genericPages) {
      const item = navItem(page.title, "", () => setView({ type: "generic", pageUrl: page.url }));
      item.dataset.url = page.url;
      section.appendChild(item);
    }
    sidebar.appendChild(section);
  }
}

function navItem(label, count, onClick) {
  const div = document.createElement("div");
  div.className = "nav-item";
  div.innerHTML = `<span>${escapeHtml(label)}</span><span class="count">${count}</span>`;
  div.addEventListener("click", onClick);
  return div;
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setView(view) {
  state.currentView = view;
  highlightActiveNav();
  render();
}

function highlightActiveNav() {
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  if (state.currentView.type === "page" || state.currentView.type === "generic") {
    const el = document.querySelector(`.nav-item[data-url="${cssEscape(state.currentView.pageUrl)}"]`);
    if (el) el.classList.add("active");
  }
}

function cssEscape(str) {
  return String(str).replace(/["\\]/g, "\\$&");
}

function render() {
  const main = document.getElementById("main-content");
  main.innerHTML = "";

  const view = state.currentView;
  if (view.type === "page") {
    renderQuestionPage(main, state.pages.find((p) => p.url === view.pageUrl));
  } else if (view.type === "generic") {
    renderGenericPage(main, state.genericPages.find((p) => p.url === view.pageUrl));
  } else if (view.type === "flagged") {
    renderFlaggedView(main);
  } else if (view.type === "quiz-setup") {
    renderQuizSetup(main);
  } else if (view.type === "quiz") {
    renderQuiz(main);
  } else if (view.type === "exam-setup") {
    renderExamSetup(main, !!view.difficultOnly);
  } else if (view.type === "exam") {
    renderExam(main);
  } else if (view.type === "exam-results") {
    renderExamResults(main);
  } else if (view.type === "account") {
    renderAccountPanel(main);
  } else {
    main.innerHTML = `<div class="empty-state">Sélectionne une catégorie dans le menu.</div>`;
  }
}

function renderPageHeader(container, title, meta) {
  const h = document.createElement("div");
  h.innerHTML = `<div class="page-title">${escapeHtml(title)}</div><div class="page-meta">${meta || ""}</div>`;
  container.appendChild(h);
}

function renderQuestionList(container, questions, options = {}) {
  for (const q of questions) {
    container.appendChild(renderQuestionCard(q, options));
  }
}

function renderQuestionCard(q, options = {}) {
  const card = document.createElement("div");
  card.className = "question-card";
  card.dataset.qid = q.id;

  const isFlagged = state.flagged.has(q.id);
  const head = document.createElement("div");
  head.className = "question-head";
  head.innerHTML = `
    <span class="question-number">Question ${q.number}${q.multi_answer ? " (Choose multiple)" : ""}${options.showPageTitle ? ` — ${escapeHtml(q.pageTitle)}` : ""}</span>
    <button class="flag-btn ${isFlagged ? "flagged" : ""}" title="Marquer comme difficile">${isFlagged ? "★" : "☆"}</button>
  `;
  head.querySelector(".flag-btn").addEventListener("click", () => {
    toggleFlag(q.id);
    card.querySelector(".flag-btn").classList.toggle("flagged");
    card.querySelector(".flag-btn").textContent = state.flagged.has(q.id) ? "★" : "☆";
    updateSidebarCounts();
  });
  card.appendChild(head);

  const textEl = document.createElement("div");
  textEl.className = "question-text";
  textEl.textContent = q.text;
  card.appendChild(textEl);

  for (const src of q.images || []) {
    const img = document.createElement("img");
    img.src = src;
    img.className = "question-img";
    img.loading = "lazy";
    card.appendChild(img);
  }

  const choicesList = document.createElement("ul");
  choicesList.className = "choices";
  for (const choice of q.choices) {
    const li = document.createElement("li");
    li.className = "choice";
    li.innerHTML = `<span class="letter">${choice.letter}.</span>${escapeHtml(choice.text)}`;
    li.dataset.letter = choice.letter;
    li.addEventListener("click", () => {
      if (q.multi_answer) {
        li.classList.toggle("selected");
      } else {
        choicesList.querySelectorAll(".choice").forEach((el) => el.classList.remove("selected"));
        li.classList.add("selected");
      }
      if (!answerBox.classList.contains("hidden")) {
        updateChoiceColors(choicesList, q.answer, selectedLetters(choicesList));
      }
    });
    choicesList.appendChild(li);
  }
  card.appendChild(choicesList);

  const answerRow = document.createElement("div");
  answerRow.className = "answer-row";
  const revealBtn = document.createElement("button");
  revealBtn.className = "reveal-btn";
  revealBtn.textContent = "Révéler la réponse";
  const answerBox = document.createElement("div");
  answerBox.className = "answer-reveal hidden";
  answerBox.textContent = `Réponse : ${q.answer.join(", ")}`;

  revealBtn.addEventListener("click", () => {
    answerBox.classList.toggle("hidden");
    const revealed = !answerBox.classList.contains("hidden");
    revealBtn.textContent = revealed ? "Masquer la réponse" : "Révéler la réponse";
    if (revealed) {
      markSeen(q.id);
      updateChoiceColors(choicesList, q.answer, selectedLetters(choicesList));
    } else {
      choicesList.querySelectorAll(".choice").forEach((li) => li.classList.remove("correct", "incorrect"));
    }
  });
  answerRow.appendChild(revealBtn);

  if (q.explanation) {
    const expBtn = document.createElement("button");
    expBtn.textContent = "Voir l'explication";
    const expBox = document.createElement("div");
    expBox.className = "explanation-box hidden";
    expBox.textContent = q.explanation;
    expBtn.addEventListener("click", () => {
      expBox.classList.toggle("hidden");
      expBtn.textContent = expBox.classList.contains("hidden") ? "Voir l'explication" : "Masquer l'explication";
    });
    answerRow.appendChild(expBtn);
    card.appendChild(answerRow);
    card.appendChild(answerBox);
    card.appendChild(expBox);
  } else {
    card.appendChild(answerRow);
    card.appendChild(answerBox);
  }

  if (q.reference) {
    const ref = document.createElement("div");
    ref.className = "reference-link";
    ref.innerHTML = `Référence : <a href="${escapeHtml(q.reference)}" target="_blank" rel="noopener noreferrer">${escapeHtml(q.reference)}</a>`;
    card.appendChild(ref);
  }

  if (!state.globalAnswersHidden) {
    answerBox.classList.remove("hidden");
    revealBtn.textContent = "Masquer la réponse";
    updateChoiceColors(choicesList, q.answer, selectedLetters(choicesList));
  }

  return card;
}

function selectedLetters(choicesList) {
  return new Set(Array.from(choicesList.querySelectorAll(".choice.selected")).map((el) => el.dataset.letter));
}

function updateChoiceColors(choicesList, correctLetters, selectedSet) {
  choicesList.querySelectorAll(".choice").forEach((li) => {
    const letter = li.dataset.letter;
    li.classList.remove("correct", "incorrect");
    if (correctLetters.includes(letter)) {
      li.classList.add("correct");
    } else if (selectedSet.has(letter)) {
      li.classList.add("incorrect");
    }
  });
}

function markSeen(id) {
  if (!state.seen.has(id)) {
    state.seen.add(id);
    Api.markSeen(id).catch((e) => console.error("markSeen failed", e));
    updateSidebarCounts();
  }
}

function toggleFlag(id) {
  const nowFlagged = !state.flagged.has(id);
  if (nowFlagged) {
    state.flagged.add(id);
  } else {
    state.flagged.delete(id);
  }
  Api.setFlag(id, nowFlagged).catch((e) => console.error("setFlag failed", e));
}

function updateSidebarCounts() {
  buildSidebar();
  highlightActiveNav();
}

function renderQuestionPage(main, page) {
  if (!page) {
    main.innerHTML = `<div class="empty-state">Page introuvable.</div>`;
    return;
  }
  renderPageHeader(main, page.title, `${page.category}${page.section ? " · " + page.section : ""} — ${page.questions.length} questions`);

  if (page.intro) {
    const intro = document.createElement("div");
    intro.className = "intro-box";
    intro.textContent = page.intro;
    main.appendChild(intro);
  }

  renderQuestionList(main, page.questions.map((q) => ({ ...q, id: questionId(page.url, q.number), pageUrl: page.url, pageTitle: page.title })));
}

function renderGenericPage(main, page) {
  if (!page) {
    main.innerHTML = `<div class="empty-state">Page introuvable.</div>`;
    return;
  }
  renderPageHeader(main, page.title, "Lab Sim / Tutoriel");
  const box = document.createElement("div");
  box.className = "intro-box";
  box.textContent = page.text || "(Contenu interactif — voir la page originale sur 9tut.com)";
  main.appendChild(box);
  for (const src of page.images || []) {
    const img = document.createElement("img");
    img.src = src;
    img.className = "question-img";
    img.loading = "lazy";
    main.appendChild(img);
  }
}

function renderFlaggedView(main) {
  renderPageHeader(main, "Questions marquées difficiles", `${state.flagged.size} question(s)`);
  const flaggedQuestions = state.questions.filter((q) => state.flagged.has(q.id));
  if (!flaggedQuestions.length) {
    main.innerHTML += `<div class="empty-state">Aucune question marquée pour l'instant. Clique sur l'étoile ☆ d'une question pour l'ajouter ici.</div>`;
    return;
  }
  renderQuestionList(main, flaggedQuestions, { showPageTitle: true });
}

function renderQuizSetup(main) {
  renderPageHeader(main, "Mode Quiz", "Teste tes connaissances avec des réponses cachées jusqu'à validation.");

  const form = document.createElement("div");
  form.className = "question-card";

  const categories = Array.from(new Set(state.pages.map((p) => p.category)));
  const scopeOptions = [
    `<option value="all">Toutes les questions</option>`,
    `<option value="flagged">Uniquement les questions marquées difficiles (${state.flagged.size})</option>`,
    ...categories.map((c) => `<option value="cat:${escapeHtml(c)}">${escapeHtml(c)}</option>`),
    ...state.pages.map((p) => `<option value="page:${escapeHtml(p.url)}">${escapeHtml(p.title)}</option>`),
  ];

  form.innerHTML = `
    <label>Portée du quiz<br><select id="quiz-scope">${scopeOptions.join("")}</select></label>
    <br><br>
    <label>Nombre de questions<br><input type="text" id="quiz-count" value="15" style="width:80px"></label>
    <br><br>
    <button class="primary" id="quiz-start">Démarrer le quiz</button>
  `;
  main.appendChild(form);

  document.getElementById("quiz-start").addEventListener("click", () => {
    const scope = document.getElementById("quiz-scope").value;
    const count = parseInt(document.getElementById("quiz-count").value, 10) || 10;
    startQuiz(scope, count);
  });
}

function startQuiz(scope, count) {
  let pool;
  if (scope === "all") {
    pool = state.questions;
  } else if (scope === "flagged") {
    pool = state.questions.filter((q) => state.flagged.has(q.id));
  } else if (scope.startsWith("cat:")) {
    const cat = scope.slice(4);
    pool = state.questions.filter((q) => q.category === cat);
  } else if (scope.startsWith("page:")) {
    const url = scope.slice(5);
    pool = state.questions.filter((q) => q.pageUrl === url);
  } else {
    pool = state.questions;
  }

  const shuffled = shuffle([...pool]).slice(0, count);
  state.quiz = {
    scope,
    questions: shuffled,
    index: 0,
    correct: 0,
    answered: false,
    selected: [],
  };
  setView({ type: "quiz" });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function renderQuiz(main) {
  const quiz = state.quiz;
  if (!quiz || quiz.questions.length === 0) {
    main.innerHTML = `<div class="empty-state">Aucune question disponible pour ce quiz.</div>`;
    return;
  }

  if (quiz.index >= quiz.questions.length) {
    renderQuizResults(main);
    return;
  }

  const q = quiz.questions[quiz.index];
  renderPageHeader(main, "Mode Quiz", `Question ${quiz.index + 1} / ${quiz.questions.length}`);

  const scoreEl = document.createElement("div");
  scoreEl.className = "quiz-score";
  scoreEl.textContent = `Score : ${quiz.correct} / ${quiz.index}`;
  main.appendChild(scoreEl);

  const card = document.createElement("div");
  card.className = "question-card";
  card.innerHTML = `
    <div class="question-number">Question ${q.number} — ${escapeHtml(q.pageTitle)}</div>
    <div class="question-text">${escapeHtml(q.text)}</div>
  `;

  const choicesList = document.createElement("ul");
  choicesList.className = "choices";
  const selected = new Set();

  for (const choice of q.choices) {
    const li = document.createElement("li");
    li.className = "choice";
    li.innerHTML = `<span class="letter">${choice.letter}.</span>${escapeHtml(choice.text)}`;
    li.dataset.letter = choice.letter;
    li.addEventListener("click", () => {
      if (quiz.answered) return;
      if (q.multi_answer) {
        li.classList.toggle("selected");
        if (selected.has(choice.letter)) selected.delete(choice.letter);
        else selected.add(choice.letter);
      } else {
        choicesList.querySelectorAll(".choice").forEach((el) => el.classList.remove("selected"));
        selected.clear();
        selected.add(choice.letter);
        li.classList.add("selected");
      }
    });
    choicesList.appendChild(li);
  }
  card.appendChild(choicesList);

  const validateBtn = document.createElement("button");
  validateBtn.className = "primary";
  validateBtn.textContent = "Valider ma réponse";
  card.appendChild(validateBtn);

  const explanationBox = document.createElement("div");
  explanationBox.className = "explanation-box hidden";
  explanationBox.textContent = q.explanation || "(Pas d'explication disponible pour cette question)";

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Question suivante →";
  nextBtn.classList.add("hidden");

  validateBtn.addEventListener("click", () => {
    if (quiz.answered || selected.size === 0) return;
    quiz.answered = true;
    markSeen(q.id);

    const correctSet = new Set(q.answer);
    const isCorrect = correctSet.size === selected.size && [...selected].every((l) => correctSet.has(l));
    if (isCorrect) quiz.correct += 1;

    recordQuizStat(q.category, isCorrect);

    choicesList.querySelectorAll(".choice").forEach((li) => {
      const letter = li.dataset.letter;
      if (correctSet.has(letter)) li.classList.add("correct");
      else if (selected.has(letter)) li.classList.add("incorrect");
    });

    validateBtn.classList.add("hidden");
    nextBtn.classList.remove("hidden");
    card.appendChild(explanationBox);
    explanationBox.classList.remove("hidden");
    scoreEl.textContent = `Score : ${quiz.correct} / ${quiz.index + 1}`;
  });

  nextBtn.addEventListener("click", () => {
    quiz.index += 1;
    quiz.answered = false;
    render();
  });

  card.appendChild(nextBtn);
  main.appendChild(card);
}

function recordQuizStat(category, isCorrect) {
  if (!state.quizStats[category]) state.quizStats[category] = { correct: 0, total: 0 };
  state.quizStats[category].total += 1;
  if (isCorrect) state.quizStats[category].correct += 1;
  Api.recordQuizStat(category, isCorrect).catch((e) => console.error("recordQuizStat failed", e));
}

function renderQuizResults(main) {
  const quiz = state.quiz;
  renderPageHeader(main, "Résultats du quiz", "");
  const pct = quiz.questions.length ? Math.round((100 * quiz.correct) / quiz.questions.length) : 0;
  const box = document.createElement("div");
  box.className = "question-card";
  box.innerHTML = `
    <div class="quiz-score">Score final : ${quiz.correct} / ${quiz.questions.length} (${pct}%)</div>
    <button class="primary" id="quiz-again">Nouveau quiz</button>
  `;
  main.appendChild(box);
  document.getElementById("quiz-again").addEventListener("click", () => setView({ type: "quiz-setup" }));
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function gradableQuestionsOfPage(page) {
  return page.questions.filter((q) => q.choices && q.choices.length && q.answer && q.answer.length);
}

function renderExamSetup(main, difficultOnly) {
  if (difficultOnly) {
    renderDifficultExamSetup(main);
    return;
  }

  renderPageHeader(main, "Mode Examen", "Simulation en conditions d'examen : questions chronométrées, réponses et explications masquées jusqu'à la fin.");

  const pagesByCategory = groupBy(state.pages, (p) => p.category);

  const form = document.createElement("div");
  form.className = "question-card";
  form.innerHTML = `
    <label>Nombre de questions<br><input type="text" id="exam-count" value="60" style="width:80px"></label>
    <br><br>
    <label>Durée (minutes)<br><input type="text" id="exam-duration" value="120" style="width:80px"></label>
    <br><br>
    <label>Ordre des questions<br>
      <select id="exam-mode">
        <option value="sequential">Séquentiel (dans l'ordre des pages cochées ci-dessous)</option>
        <option value="random">Aléatoire (parmi les pages cochées ci-dessous)</option>
      </select>
    </label>
  `;
  main.appendChild(form);

  const pickerBox = document.createElement("div");
  pickerBox.className = "question-card";
  let pickerHtml = `<div class="page-title" style="font-size:16px;margin-bottom:6px;">Pages / catégories à inclure</div>
    <div class="page-meta" style="margin-bottom:10px;">Coche les pages dont les questions doivent alimenter les 60 (ou N) questions cumulées de l'examen. Fonctionne aussi bien pour la catégorie CCNA 200-301 que pour la Premium Member Zone.</div>`;

  let runningDefaultTotal = 0;
  const defaultCheckedUrls = new Set();

  for (const [category, pages] of pagesByCategory) {
    pickerHtml += `
      <div style="margin:14px 0 6px; display:flex; justify-content:space-between; align-items:center;">
        <strong>${escapeHtml(category)}</strong>
        <span>
          <button type="button" class="exam-select-all" data-cat="${escapeHtml(category)}" style="font-size:12px; padding:4px 8px;">Tout cocher</button>
          <button type="button" class="exam-select-none" data-cat="${escapeHtml(category)}" style="font-size:12px; padding:4px 8px;">Tout décocher</button>
        </span>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">`;
    for (const page of pages) {
      const count = gradableQuestionsOfPage(page).length;
      if (!count) continue;
      // Default suggestion: pre-check CCNA 200-301 pages in site order until ~60 questions are covered.
      const isDefaultChecked = category === EXAM_DEFAULT_CATEGORY && runningDefaultTotal < 60;
      if (isDefaultChecked) {
        runningDefaultTotal += count;
        defaultCheckedUrls.add(page.url);
      }
      pickerHtml += `
        <label style="display:flex; align-items:center; gap:8px; font-size:13px;">
          <input type="checkbox" class="exam-page-check" value="${escapeHtml(page.url)}" ${isDefaultChecked ? "checked" : ""}>
          ${escapeHtml(page.title)} <span class="page-meta">(${count})</span>
        </label>`;
    }
    pickerHtml += `</div>`;
  }
  pickerHtml += `<br><div class="page-meta" id="exam-total-selected">0 question(s) sélectionnée(s)</div>`;
  pickerBox.innerHTML = pickerHtml;
  main.appendChild(pickerBox);

  function updateSelectedTotal() {
    const checked = Array.from(pickerBox.querySelectorAll(".exam-page-check:checked")).map((el) => el.value);
    const total = checked.reduce((sum, url) => {
      const page = state.pages.find((p) => p.url === url);
      return sum + (page ? gradableQuestionsOfPage(page).length : 0);
    }, 0);
    pickerBox.querySelector("#exam-total-selected").textContent = `${total} question(s) disponible(s) dans la sélection`;
  }

  pickerBox.addEventListener("change", (e) => {
    if (e.target.classList.contains("exam-page-check")) updateSelectedTotal();
  });
  pickerBox.querySelectorAll(".exam-select-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      pickerBox.querySelectorAll(`.exam-page-check`).forEach((cb) => {
        const page = state.pages.find((p) => p.url === cb.value);
        if (page && page.category === btn.dataset.cat) cb.checked = true;
      });
      updateSelectedTotal();
    });
  });
  pickerBox.querySelectorAll(".exam-select-none").forEach((btn) => {
    btn.addEventListener("click", () => {
      pickerBox.querySelectorAll(`.exam-page-check`).forEach((cb) => {
        const page = state.pages.find((p) => p.url === cb.value);
        if (page && page.category === btn.dataset.cat) cb.checked = false;
      });
      updateSelectedTotal();
    });
  });
  updateSelectedTotal();

  const startBox = document.createElement("div");
  startBox.className = "question-card";
  startBox.innerHTML = `<button class="primary" id="exam-start">Démarrer l'examen</button>`;
  main.appendChild(startBox);

  document.getElementById("exam-start").addEventListener("click", () => {
    const checkedUrls = Array.from(pickerBox.querySelectorAll(".exam-page-check:checked")).map((el) => el.value);
    if (!checkedUrls.length) {
      alert("Coche au moins une page pour démarrer l'examen.");
      return;
    }
    const checkedSet = new Set(checkedUrls);
    const orderedPages = state.pages.filter((p) => checkedSet.has(p.url));
    const pool = state.questions.filter((q) => checkedSet.has(q.pageUrl) && q.choices.length && q.answer.length);

    const count = Math.max(1, parseInt(document.getElementById("exam-count").value, 10) || 60);
    const durationMin = Math.max(1, parseInt(document.getElementById("exam-duration").value, 10) || 120);
    const mode = document.getElementById("exam-mode").value;
    const label = orderedPages.length === 1 ? orderedPages[0].title : `Personnalisé (${orderedPages.length} page${orderedPages.length > 1 ? "s" : ""})`;
    startExam({ mode, count, durationMin, pool, label });
  });

  renderExamHistoryTable(main);
}

function renderDifficultExamSetup(main) {
  renderPageHeader(main, "Examen spécial — Questions difficiles", "Ré-affronte uniquement les questions marquées difficiles (⭐), avec une durée adaptée au nombre de questions, plafonnée à 2h.");

  const pool = state.questions.filter((q) => state.flagged.has(q.id) && q.choices.length && q.answer.length);
  const count = pool.length;
  const durationMin = count ? Math.min(EXAM_MAX_MINUTES, Math.max(5, Math.round((count * EXAM_SECONDS_PER_QUESTION) / 60))) : 0;

  const box = document.createElement("div");
  box.className = "question-card";
  if (!count) {
    box.innerHTML = `<div class="empty-state">Aucune question marquée difficile pour le moment. Marque des questions avec ☆ (ou depuis les résultats d'un examen) pour alimenter cet examen spécial.</div>`;
    main.appendChild(box);
    return;
  }

  box.innerHTML = `
    <div class="page-meta">${count} question(s) difficile(s) disponibles.</div>
    <div class="page-meta">Durée calculée : ${durationMin} minute(s) (≈${Math.round(EXAM_SECONDS_PER_QUESTION / 60)} min/question, plafonné à ${EXAM_MAX_MINUTES} min).</div>
    <br>
    <button class="primary" id="exam-difficult-start">Démarrer l'examen spécial</button>
  `;
  main.appendChild(box);

  document.getElementById("exam-difficult-start").addEventListener("click", () => {
    startExam({
      mode: "random",
      count,
      durationMin,
      pool,
      label: "Questions difficiles",
      isDifficultReview: true,
    });
  });

  renderExamHistoryTable(main);
}

function renderExamHistoryTable(main) {
  if (!state.examHistory.length) return;

  const box = document.createElement("div");
  box.className = "question-card";
  const rows = [...state.examHistory]
    .reverse()
    .slice(0, 15)
    .map((h) => {
      const pct = h.total ? Math.round((100 * h.score) / h.total) : 0;
      const date = new Date(h.date).toLocaleString();
      const passed = pct >= EXAM_PASS_PCT;
      return `<tr>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(h.label || (h.mode === "sequential" ? "Séquentiel" : "Aléatoire"))}</td>
        <td>${h.score} / ${h.total} (${pct}%)</td>
        <td>${formatClock(h.durationSeconds)} / ${formatClock(h.timeLimitSeconds)}</td>
        <td style="color:${passed ? "var(--good)" : "var(--bad)"}">${passed ? "Objectif atteint" : "En dessous de l'objectif"}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `
    <div class="page-title" style="font-size:16px;margin-bottom:10px;">Historique des examens</div>
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse: collapse; font-size:13px;">
        <thead><tr style="text-align:left; color: var(--muted);">
          <th>Date</th><th>Portée</th><th>Score</th><th>Temps</th><th>Résultat</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  main.appendChild(box);
}

function startExam({ mode, count, durationMin, pool, label, isDifficultReview }) {
  let selected;
  if (mode === "random") {
    selected = shuffle([...pool]).slice(0, count);
  } else {
    selected = pool.slice(0, count); // pool is already in the order of the checked pages
  }

  state.exam = {
    mode,
    label: label || "Personnalisé",
    isDifficultReview: !!isDifficultReview,
    questions: selected,
    answers: {}, // questionId -> array of selected letters
    timings: {}, // questionId -> seconds spent
    currentQid: selected.length ? selected[0].id : null,
    currentStartedAt: Date.now(),
    index: 0,
    timeLimitSeconds: durationMin * 60,
    remainingSeconds: durationMin * 60,
    startedAt: Date.now(),
    finished: false,
  };

  if (state.examTimerHandle) clearInterval(state.examTimerHandle);
  state.examTimerHandle = setInterval(tickExamTimer, 1000);

  setView({ type: "exam" });
}

function commitCurrentExamTime() {
  const exam = state.exam;
  if (!exam || !exam.currentQid) return;
  const now = Date.now();
  const elapsed = (now - exam.currentStartedAt) / 1000;
  exam.timings[exam.currentQid] = (exam.timings[exam.currentQid] || 0) + elapsed;
  exam.currentStartedAt = now;
}

function goToExamQuestion(newIndex) {
  const exam = state.exam;
  if (!exam) return;
  commitCurrentExamTime();
  exam.index = newIndex;
  exam.currentQid = exam.questions[newIndex].id;
  render();
}

function tickExamTimer() {
  const exam = state.exam;
  if (!exam || exam.finished) return;
  exam.remainingSeconds -= 1;

  const timerEl = document.getElementById("exam-timer");
  if (timerEl) {
    timerEl.textContent = formatClock(exam.remainingSeconds);
    timerEl.classList.toggle("bad", exam.remainingSeconds <= 300);
  }

  const qTimeEl = document.getElementById("exam-current-qtime");
  if (qTimeEl && exam.currentQid) {
    const already = exam.timings[exam.currentQid] || 0;
    const liveElapsed = (Date.now() - exam.currentStartedAt) / 1000;
    qTimeEl.textContent = `Temps sur cette question : ${formatClock(already + liveElapsed)}`;
  }

  if (exam.remainingSeconds <= 0) {
    finishExam(true);
  }
}

function finishExam(timedOut) {
  const exam = state.exam;
  if (!exam || exam.finished) return;

  commitCurrentExamTime();

  if (state.examTimerHandle) {
    clearInterval(state.examTimerHandle);
    state.examTimerHandle = null;
  }

  exam.finished = true;
  exam.timedOut = !!timedOut;
  exam.durationSeconds = exam.timeLimitSeconds - Math.max(0, exam.remainingSeconds);

  let score = 0;
  const unflaggedIds = [];
  const questionResults = [];
  for (const q of exam.questions) {
    markSeen(q.id);
    const given = Array.from(exam.answers[q.id] || []);
    const correctSet = new Set(q.answer);
    const isCorrect = given.length > 0 && correctSet.size === given.length && given.every((l) => correctSet.has(l));
    if (isCorrect) score += 1;

    questionResults.push({
      questionKey: q.id,
      given,
      timeSeconds: exam.timings[q.id] || 0,
      isCorrect,
    });

    // In the special "difficult questions" exam, a correct answer means the
    // question is mastered — take it out of the to-review pool.
    if (exam.isDifficultReview && isCorrect && state.flagged.has(q.id)) {
      state.flagged.delete(q.id);
      unflaggedIds.push(q.id);
    }
  }
  exam.score = score;
  if (unflaggedIds.length) {
    Api.setFlagsBulk([], unflaggedIds).catch((e) => console.error("setFlagsBulk failed", e));
    updateSidebarCounts();
  }

  const examRecord = {
    date: new Date().toISOString(),
    mode: exam.mode,
    label: exam.label,
    score,
    total: exam.questions.length,
    durationSeconds: exam.durationSeconds,
    timeLimitSeconds: exam.timeLimitSeconds,
    timedOut: exam.timedOut,
    isDifficultReview: exam.isDifficultReview,
    questionResults,
  };
  state.examHistory.push(examRecord);
  Api.recordExam(examRecord).catch((e) => console.error("recordExam failed", e));

  setView({ type: "exam-results" });
}

function renderExam(main) {
  const exam = state.exam;
  if (!exam || !exam.questions.length) {
    main.innerHTML = `<div class="empty-state">Aucun examen en cours. Configure un nouvel examen depuis "🎓 Mode Examen".</div>`;
    return;
  }
  if (exam.finished) {
    renderExamResults(main);
    return;
  }

  const q = exam.questions[exam.index];
  const answeredCount = Object.keys(exam.answers).filter((id) => exam.answers[id] && exam.answers[id].length).length;

  const header = document.createElement("div");
  header.innerHTML = `
    <div class="page-title">Mode Examen — Question ${exam.index + 1} / ${exam.questions.length}</div>
    <div class="page-meta">Répondues : ${answeredCount} / ${exam.questions.length}</div>
  `;
  main.appendChild(header);

  const timerRow = document.createElement("div");
  timerRow.className = "quiz-score";
  timerRow.innerHTML = `Temps restant : <span id="exam-timer" class="${exam.remainingSeconds <= 300 ? "bad" : ""}">${formatClock(exam.remainingSeconds)}</span>`;
  main.appendChild(timerRow);

  const qTimeRow = document.createElement("div");
  qTimeRow.className = "page-meta";
  qTimeRow.id = "exam-current-qtime";
  qTimeRow.style.marginBottom = "10px";
  qTimeRow.textContent = `Temps sur cette question : ${formatClock(exam.timings[q.id] || 0)}`;
  main.appendChild(qTimeRow);

  const palette = document.createElement("div");
  palette.style.display = "flex";
  palette.style.flexWrap = "wrap";
  palette.style.gap = "4px";
  palette.style.margin = "10px 0 16px";
  exam.questions.forEach((pq, i) => {
    const btn = document.createElement("button");
    const isAnswered = exam.answers[pq.id] && exam.answers[pq.id].length;
    btn.textContent = i + 1;
    btn.style.width = "34px";
    btn.style.padding = "4px 0";
    if (i === exam.index) btn.classList.add("primary");
    else if (isAnswered) btn.style.borderColor = "var(--good)";
    btn.addEventListener("click", () => goToExamQuestion(i));
    palette.appendChild(btn);
  });
  main.appendChild(palette);

  const card = document.createElement("div");
  card.className = "question-card";
  card.innerHTML = `
    <div class="question-number">Question ${q.number}${q.multi_answer ? " (Choose multiple)" : ""}</div>
    <div class="question-text">${escapeHtml(q.text)}</div>
  `;

  for (const src of q.images || []) {
    const img = document.createElement("img");
    img.src = src;
    img.className = "question-img";
    img.loading = "lazy";
    card.appendChild(img);
  }

  const choicesList = document.createElement("ul");
  choicesList.className = "choices";
  const selected = new Set(exam.answers[q.id] || []);

  for (const choice of q.choices) {
    const li = document.createElement("li");
    li.className = "choice";
    if (selected.has(choice.letter)) li.classList.add("selected");
    li.innerHTML = `<span class="letter">${choice.letter}.</span>${escapeHtml(choice.text)}`;
    li.dataset.letter = choice.letter;
    li.addEventListener("click", () => {
      if (q.multi_answer) {
        li.classList.toggle("selected");
        if (selected.has(choice.letter)) selected.delete(choice.letter);
        else selected.add(choice.letter);
      } else {
        choicesList.querySelectorAll(".choice").forEach((el) => el.classList.remove("selected"));
        selected.clear();
        selected.add(choice.letter);
        li.classList.add("selected");
      }
      exam.answers[q.id] = Array.from(selected);
      const btn = palette.children[exam.index];
      if (btn) btn.style.borderColor = "var(--good)";
    });
    choicesList.appendChild(li);
  }
  card.appendChild(choicesList);
  main.appendChild(card);

  const navRow = document.createElement("div");
  navRow.className = "exam-nav";
  navRow.style.marginTop = "16px";

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "← Précédent";
  prevBtn.disabled = exam.index === 0;
  prevBtn.addEventListener("click", () => goToExamQuestion(Math.max(0, exam.index - 1)));
  navRow.appendChild(prevBtn);

  if (exam.index < exam.questions.length - 1) {
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "Suivant →";
    nextBtn.addEventListener("click", () => goToExamQuestion(exam.index + 1));
    navRow.appendChild(nextBtn);
  }

  const finishBtn = document.createElement("button");
  finishBtn.className = "danger";
  finishBtn.textContent = "Terminer l'examen";
  finishBtn.addEventListener("click", () => {
    if (confirm("Terminer l'examen maintenant et voir le score ?")) {
      finishExam(false);
    }
  });
  navRow.appendChild(finishBtn);

  main.appendChild(navRow);
}

function renderExamResults(main) {
  const exam = state.exam;
  if (!exam) {
    main.innerHTML = `<div class="empty-state">Aucun résultat d'examen disponible.</div>`;
    return;
  }

  const pct = exam.questions.length ? Math.round((100 * exam.score) / exam.questions.length) : 0;
  const passed = pct >= EXAM_PASS_PCT;

  renderPageHeader(main, "Résultats de l'examen", `${escapeHtml(exam.label || "")}${exam.timedOut ? " — Temps écoulé, examen soumis automatiquement." : ""}`);

  const summary = document.createElement("div");
  summary.className = "question-card";
  summary.innerHTML = `
    <div class="quiz-score">Score : ${exam.score} / ${exam.questions.length} (${pct}%)</div>
    <div class="quiz-score" style="color:${passed ? "var(--good)" : "var(--bad)"}">${passed ? "✓ Objectif d'examen atteint (≈82%+)" : "✗ En dessous de l'objectif visé (≈82%+)"}</div>
    <div class="page-meta">Temps utilisé : ${formatClock(exam.durationSeconds)} / ${formatClock(exam.timeLimitSeconds)}</div>
    <br>
    <button class="primary" id="exam-again">Nouvel examen</button>
    <button id="exam-flag-missed">★ Marquer les questions ratées comme difficiles</button>
    <button id="exam-flag-slow">⏱ Marquer les questions lentes comme difficiles</button>
  `;
  main.appendChild(summary);

  document.getElementById("exam-again").addEventListener("click", () => {
    state.exam = null;
    setView({ type: "exam-setup" });
  });

  const isCorrectQ = (q) => {
    const given = new Set(exam.answers[q.id] || []);
    const correctSet = new Set(q.answer);
    return given.size > 0 && correctSet.size === given.size && [...given].every((l) => correctSet.has(l));
  };
  const missed = exam.questions.filter((q) => !isCorrectQ(q));

  document.getElementById("exam-flag-missed").addEventListener("click", () => {
    for (const q of missed) state.flagged.add(q.id);
    Api.setFlagsBulk(missed.map((q) => q.id), []).catch((e) => console.error("setFlagsBulk failed", e));
    updateSidebarCounts();
    render();
  });

  // --- Time analysis ---
  const timedQuestions = exam.questions
    .map((q) => ({ q, time: exam.timings[q.id] || 0 }))
    .filter((e) => e.time > 0);
  const avgTime = timedQuestions.length ? timedQuestions.reduce((s, e) => s + e.time, 0) / timedQuestions.length : 0;
  const slowThreshold = avgTime * EXAM_SLOW_FACTOR;
  const slowest = [...timedQuestions].sort((a, b) => b.time - a.time).slice(0, 10);
  const slowQuestions = timedQuestions.filter((e) => e.time > slowThreshold).map((e) => e.q);

  document.getElementById("exam-flag-slow").addEventListener("click", () => {
    for (const q of slowQuestions) state.flagged.add(q.id);
    Api.setFlagsBulk(slowQuestions.map((q) => q.id), []).catch((e) => console.error("setFlagsBulk failed", e));
    updateSidebarCounts();
    render();
  });

  const timeBox = document.createElement("div");
  timeBox.className = "question-card";
  const rows = slowest
    .map(
      ({ q, time }) => `<tr${time > slowThreshold ? ' style="color: var(--warn)"' : ""}>
        <td>Q${q.number} — ${escapeHtml(q.pageTitle)}</td>
        <td>${formatClock(time)}</td>
        <td>${isCorrectQ(q) ? "✓" : "✗"}</td>
      </tr>`
    )
    .join("");
  timeBox.innerHTML = `
    <div class="page-title" style="font-size:16px;margin-bottom:6px;">⏱ Analyse du temps</div>
    <div class="page-meta" style="margin-bottom:10px;">Temps moyen par question répondue : ${formatClock(avgTime)}. Questions les plus lentes (candidates à accélérer) :</div>
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse: collapse; font-size:13px;">
        <thead><tr style="text-align:left; color: var(--muted);"><th>Question</th><th>Temps</th><th>Correct</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">Pas de données de temps (examen terminé sans visiter de question).</td></tr>`}</tbody>
      </table>
    </div>
  `;
  main.appendChild(timeBox);

  const missedHeader = document.createElement("div");
  missedHeader.className = "page-title";
  missedHeader.style.fontSize = "16px";
  missedHeader.style.margin = "20px 0 10px";
  missedHeader.textContent = `Questions ratées (${missed.length})`;
  main.appendChild(missedHeader);

  if (!missed.length) {
    main.innerHTML += `<div class="empty-state">Aucune erreur — excellent travail !</div>`;
  } else {
    for (const q of missed) {
      main.appendChild(renderExamReviewCard(q, exam.answers[q.id] || [], exam.timings[q.id] || 0));
    }
  }

  renderExamHistoryTable(main);
}

function renderExamReviewCard(q, givenLetters, timeSeconds) {
  const card = document.createElement("div");
  card.className = "question-card";

  const isFlagged = state.flagged.has(q.id);
  const head = document.createElement("div");
  head.className = "question-head";
  head.innerHTML = `
    <span class="question-number">Question ${q.number} — ${escapeHtml(q.pageTitle)} · ${formatClock(timeSeconds || 0)}</span>
    <button class="flag-btn ${isFlagged ? "flagged" : ""}">${isFlagged ? "★" : "☆"}</button>
  `;
  head.querySelector(".flag-btn").addEventListener("click", () => {
    toggleFlag(q.id);
    head.querySelector(".flag-btn").classList.toggle("flagged");
    head.querySelector(".flag-btn").textContent = state.flagged.has(q.id) ? "★" : "☆";
    updateSidebarCounts();
  });
  card.appendChild(head);

  const textEl = document.createElement("div");
  textEl.className = "question-text";
  textEl.textContent = q.text;
  card.appendChild(textEl);

  const choicesList = document.createElement("ul");
  choicesList.className = "choices";
  for (const choice of q.choices) {
    const li = document.createElement("li");
    li.className = "choice";
    if (q.answer.includes(choice.letter)) li.classList.add("correct");
    else if (givenLetters.includes(choice.letter)) li.classList.add("incorrect");
    li.innerHTML = `<span class="letter">${choice.letter}.</span>${escapeHtml(choice.text)}`;
    choicesList.appendChild(li);
  }
  card.appendChild(choicesList);

  const answerBox = document.createElement("div");
  answerBox.className = "answer-reveal";
  answerBox.textContent = `Ta réponse : ${givenLetters.length ? givenLetters.join(", ") : "(non répondu)"} — Bonne réponse : ${q.answer.join(", ")}`;
  card.appendChild(answerBox);

  if (q.explanation) {
    const expBox = document.createElement("div");
    expBox.className = "explanation-box";
    expBox.textContent = q.explanation;
    card.appendChild(expBox);
  }

  const ref = document.createElement("div");
  ref.className = "reference-link";
  ref.innerHTML = `Page source : <a href="#" class="goto-page">${escapeHtml(q.pageTitle)}</a>${q.reference ? ` — Référence externe : <a href="${escapeHtml(q.reference)}" target="_blank" rel="noopener noreferrer">${escapeHtml(q.reference)}</a>` : ""}`;
  ref.querySelector(".goto-page").addEventListener("click", (e) => {
    e.preventDefault();
    setView({ type: "page", pageUrl: q.pageUrl });
  });
  card.appendChild(ref);

  return card;
}

function updateProgressBar() {
  const total = state.questions.length;
  const seenCount = state.questions.filter((q) => state.seen.has(q.id)).length;
  const pct = total ? Math.round((100 * seenCount) / total) : 0;
  document.getElementById("progress-bar").style.width = `${pct}%`;
  document.getElementById("progress-label").textContent = `${seenCount}/${total} questions vues (${pct}%)`;
}

function setupToolbar() {
  const toggleBtn = document.getElementById("toggle-answers");
  toggleBtn.addEventListener("click", () => {
    state.globalAnswersHidden = !state.globalAnswersHidden;
    toggleBtn.textContent = state.globalAnswersHidden ? "Afficher toutes les réponses" : "Cacher toutes les réponses";
    document.querySelectorAll(".question-card").forEach((card) => {
      const answerBox = card.querySelector(".answer-reveal");
      if (!answerBox) return;
      answerBox.classList.toggle("hidden", state.globalAnswersHidden);
      const revealBtn = card.querySelector(".reveal-btn");
      if (revealBtn) revealBtn.textContent = state.globalAnswersHidden ? "Révéler la réponse" : "Masquer la réponse";
      const choicesList = card.querySelector(".choices");
      if (!choicesList) return;
      if (state.globalAnswersHidden) {
        choicesList.querySelectorAll(".choice").forEach((li) => li.classList.remove("correct", "incorrect"));
      } else {
        const q = state.questions.find((qq) => qq.id === card.dataset.qid);
        if (q) updateChoiceColors(choicesList, q.answer, selectedLetters(choicesList));
      }
    });
  });

  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim().toLowerCase();
    if (!term) return;
    const matches = state.questions.filter((q) => q.text.toLowerCase().includes(term));
    const main = document.getElementById("main-content");
    main.innerHTML = "";
    renderPageHeader(main, `Recherche : "${searchInput.value}"`, `${matches.length} résultat(s)`);
    renderQuestionList(main, matches, { showPageTitle: true });
  });
}

function renderAccountPanel(main) {
  renderPageHeader(main, "Mon compte", "Tes informations et ta progression sont stockées de façon permanente côté serveur (SQLite) — indépendantes du navigateur.");

  const infoBox = document.createElement("div");
  infoBox.className = "question-card";
  infoBox.innerHTML = `
    <div class="page-meta">Nom d'utilisateur (non modifiable) : <strong>${escapeHtml(state.user.username)}</strong></div>
    <br>
    <label>Nom affiché<br><input type="text" id="account-display-name" value="${escapeHtml(state.user.display_name || "")}"></label>
    <br><br>
    <label>Email<br><input type="email" id="account-email" value="${escapeHtml(state.user.email || "")}"></label>
    <br><br>
    <div id="account-info-error" class="auth-error hidden"></div>
    <button class="primary" id="account-save">Enregistrer</button>
  `;
  main.appendChild(infoBox);

  document.getElementById("account-save").addEventListener("click", async () => {
    const errorEl = document.getElementById("account-info-error");
    errorEl.classList.add("hidden");
    try {
      const display_name = document.getElementById("account-display-name").value.trim();
      const email = document.getElementById("account-email").value.trim();
      await Api.updateMe({ display_name, email: email || null });
      state.user.display_name = display_name;
      state.user.email = email;
      document.getElementById("user-name").textContent = display_name || state.user.username;
      alert("Informations mises à jour.");
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.classList.remove("hidden");
    }
  });

  const pwBox = document.createElement("div");
  pwBox.className = "question-card";
  pwBox.innerHTML = `
    <div class="page-title" style="font-size:16px;margin-bottom:6px;">Changer le mot de passe</div>
    <label>Nouveau mot de passe (6 caractères min.)<br><input type="password" id="account-new-password" minlength="6" autocomplete="new-password"></label>
    <br><br>
    <div id="account-password-error" class="auth-error hidden"></div>
    <button id="account-password-save">Changer le mot de passe</button>
  `;
  main.appendChild(pwBox);

  document.getElementById("account-password-save").addEventListener("click", async () => {
    const errorEl = document.getElementById("account-password-error");
    errorEl.classList.add("hidden");
    const password = document.getElementById("account-new-password").value;
    try {
      await Api.changePassword(password);
      document.getElementById("account-new-password").value = "";
      alert("Mot de passe changé.");
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.classList.remove("hidden");
    }
  });

  const dangerBox = document.createElement("div");
  dangerBox.className = "question-card";
  dangerBox.innerHTML = `
    <div class="page-title" style="font-size:16px;margin-bottom:6px; color: var(--bad);">Supprimer mon compte</div>
    <div class="page-meta" style="margin-bottom:10px;">Action irréversible : supprime ton compte et toute ta progression (questions vues, difficiles, quiz, examens) de la base de données.</div>
    <button class="danger" id="account-delete">Supprimer définitivement mon compte</button>
  `;
  main.appendChild(dangerBox);

  document.getElementById("account-delete").addEventListener("click", async () => {
    if (!confirm("Supprimer définitivement ton compte et toutes tes données ? Cette action est irréversible.")) return;
    if (!confirm("Confirme une dernière fois : supprimer le compte maintenant ?")) return;
    try {
      await Api.deleteMe();
      Api.clearToken();
      location.reload();
    } catch (e) {
      alert("Erreur lors de la suppression : " + e.message);
    }
  });
}

function showAuthScreen() {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("app-root").classList.add("hidden");
}

function showApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-root").classList.remove("hidden");
}

function setupAuthScreen() {
  const tabs = document.querySelectorAll(".auth-tab");
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      if (tab.dataset.tab === "login") {
        loginForm.classList.remove("hidden");
        registerForm.classList.add("hidden");
      } else {
        registerForm.classList.remove("hidden");
        loginForm.classList.add("hidden");
      }
    });
  });

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("login-error");
    errorEl.classList.add("hidden");
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    try {
      const res = await Api.login(username, password);
      Api.setToken(res.token);
      state.user = res.user;
      await startApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("register-error");
    errorEl.classList.add("hidden");
    const username = document.getElementById("register-username").value.trim();
    const email = document.getElementById("register-email").value.trim();
    const password = document.getElementById("register-password").value;
    try {
      const res = await Api.register(username, password, email || null);
      Api.setToken(res.token);
      state.user = res.user;
      await startApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });
}

function setupUserBar() {
  document.getElementById("user-name").textContent = state.user.display_name || state.user.username;
  document.getElementById("account-btn").addEventListener("click", () => setView({ type: "account" }));
  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await Api.logout();
    } catch (e) {
      /* ignore network errors on logout */
    }
    Api.clearToken();
    location.reload();
  });
}

async function startApp() {
  showApp();

  try {
    await loadData();
    await loadProgress();
  } catch (e) {
    document.getElementById("main-content").innerHTML = `
      <div class="empty-state">
        Impossible de charger les données depuis le serveur : ${escapeHtml(e.message || String(e))}<br><br>
        Vérifie que le serveur Flask est lancé (<code>python -m server.app</code>) et que la base contient des données
        (<code>python -m server.import_data</code>).
      </div>`;
    return;
  }

  buildSidebar();
  setupToolbar();
  setupUserBar();
  updateProgressBar();
  setView({ type: state.pages.length ? "page" : "quiz-setup", pageUrl: state.pages.length ? state.pages[0].url : null });

  setInterval(updateProgressBar, 2000);
}

async function init() {
  setupAuthScreen();

  const token = Api.getToken();
  if (token) {
    try {
      const res = await Api.me();
      state.user = res.user;
      await startApp();
      return;
    } catch (e) {
      Api.clearToken();
    }
  }
  showAuthScreen();
}

document.addEventListener("DOMContentLoaded", init);

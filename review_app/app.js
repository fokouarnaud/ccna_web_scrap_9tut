const STORAGE_KEYS = {
  flagged: "ccna_flagged_v1",
  seen: "ccna_seen_v1",
  quizStats: "ccna_quiz_stats_v1",
};

const state = {
  pages: [], // all Q&A pages
  genericPages: [], // lab sims / tutorial-style pages
  questions: [], // flattened, each with pageRef
  flagged: new Set(),
  seen: new Set(),
  quizStats: {}, // category -> {correct, total}
  currentView: { type: "page", pageUrl: null }, // page | flagged | quiz | generic
  globalAnswersHidden: true,
  quiz: null, // active quiz session state
};

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (e) {
    return new Set();
  }
}

function saveSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch (e) {
    /* ignore quota / privacy-mode errors */
  }
}

function loadStats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.quizStats);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveStats() {
  try {
    localStorage.setItem(STORAGE_KEYS.quizStats, JSON.stringify(state.quizStats));
  } catch (e) {
    /* ignore */
  }
}

function questionId(pageUrl, number) {
  return `${pageUrl}::${number}`;
}

async function loadData() {
  const [qRes, gRes] = await Promise.all([
    fetch("../data/ccna_questions.json"),
    fetch("../data/lab_sims.json"),
  ]);
  state.pages = await qRes.json();
  state.genericPages = await gRes.json();

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

function buildSidebar() {
  const sidebar = document.getElementById("nav-content");
  sidebar.innerHTML = "";

  const specialSection = document.createElement("div");
  specialSection.className = "nav-section";
  specialSection.innerHTML = `<h2>Révision</h2>`;
  const flaggedItem = navItem(`⭐ Questions difficiles`, state.flagged.size, () => setView({ type: "flagged" }));
  const quizItem = navItem(`🎯 Mode Quiz`, "", () => setView({ type: "quiz-setup" }));
  specialSection.appendChild(flaggedItem);
  specialSection.appendChild(quizItem);
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
    choicesList.appendChild(li);
  }
  card.appendChild(choicesList);

  const answerRow = document.createElement("div");
  answerRow.className = "answer-row";
  const revealBtn = document.createElement("button");
  revealBtn.textContent = "Révéler la réponse";
  const answerBox = document.createElement("div");
  answerBox.className = "answer-reveal hidden";
  answerBox.textContent = `Réponse : ${q.answer.join(", ")}`;

  revealBtn.addEventListener("click", () => {
    answerBox.classList.remove("hidden");
    markSeen(q.id);
    highlightChoices(choicesList, q.answer);
  });
  answerRow.appendChild(revealBtn);

  if (q.explanation) {
    const expBtn = document.createElement("button");
    expBtn.textContent = "Voir l'explication";
    const expBox = document.createElement("div");
    expBox.className = "explanation-box hidden";
    expBox.textContent = q.explanation;
    expBtn.addEventListener("click", () => expBox.classList.remove("hidden"));
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
  }

  return card;
}

function highlightChoices(choicesList, correctLetters) {
  choicesList.querySelectorAll(".choice").forEach((li) => {
    if (correctLetters.includes(li.dataset.letter)) {
      li.classList.add("correct");
    }
  });
}

function markSeen(id) {
  if (!state.seen.has(id)) {
    state.seen.add(id);
    saveSet(STORAGE_KEYS.seen, state.seen);
    updateSidebarCounts();
  }
}

function toggleFlag(id) {
  if (state.flagged.has(id)) {
    state.flagged.delete(id);
  } else {
    state.flagged.add(id);
  }
  saveSet(STORAGE_KEYS.flagged, state.flagged);
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
  saveStats();
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
    document.querySelectorAll(".answer-reveal").forEach((el) => {
      el.classList.toggle("hidden", state.globalAnswersHidden);
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

async function init() {
  state.flagged = loadSet(STORAGE_KEYS.flagged);
  state.seen = loadSet(STORAGE_KEYS.seen);
  state.quizStats = loadStats();

  try {
    await loadData();
  } catch (e) {
    document.getElementById("main-content").innerHTML = `
      <div class="empty-state">
        Impossible de charger les données (data/ccna_questions.json).<br><br>
        Les navigateurs bloquent le chargement de fichiers locaux via <code>file://</code>.<br>
        Lance un petit serveur local depuis le dossier du projet, par ex. :<br><br>
        <code>python -m http.server 8000</code><br><br>
        puis ouvre <code>http://localhost:8000/review_app/</code>.
      </div>`;
    return;
  }

  buildSidebar();
  setupToolbar();
  updateProgressBar();
  setView({ type: state.pages.length ? "page" : "quiz-setup", pageUrl: state.pages.length ? state.pages[0].url : null });

  setInterval(updateProgressBar, 2000);
}

document.addEventListener("DOMContentLoaded", init);

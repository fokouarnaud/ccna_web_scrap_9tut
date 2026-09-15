const TOKEN_KEY = "ccna_session_token_v1";

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* ignore */
  }
}

let activeRequests = 0;

function updateGlobalProgress() {
  const bar = document.getElementById("global-progress");
  if (bar) bar.classList.toggle("active", activeRequests > 0);
}

async function apiCall(path, { method = "GET", body, auth = true } = {}) {
  activeRequests += 1;
  updateGlobalProgress();
  try {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const token = getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    activeRequests -= 1;
    updateGlobalProgress();
  }
}

const Api = {
  getToken,
  setToken,
  clearToken: () => setToken(null),

  register: (username, password, email, displayName) =>
    apiCall("/api/register", { method: "POST", auth: false, body: { username, password, email, display_name: displayName } }),

  login: (username, password) => apiCall("/api/login", { method: "POST", auth: false, body: { username, password } }),

  logout: () => apiCall("/api/logout", { method: "POST" }),

  me: () => apiCall("/api/me"),

  updateMe: (fields) => apiCall("/api/me", { method: "PUT", body: fields }),

  changePassword: (password) => apiCall("/api/me/password", { method: "PUT", body: { password } }),

  deleteMe: () => apiCall("/api/me", { method: "DELETE" }),

  getQuestions: () => apiCall("/api/questions", { auth: false }),

  getLabSims: () => apiCall("/api/lab-sims", { auth: false }),

  getProgress: () => apiCall("/api/progress"),

  markSeen: (questionId) => apiCall("/api/progress/seen", { method: "POST", body: { questionId } }),

  setFlag: (questionId, flagged) => apiCall("/api/progress/flag", { method: "POST", body: { questionId, flagged } }),

  setFlagsBulk: (add, remove) => apiCall("/api/progress/flags-bulk", { method: "POST", body: { add, remove } }),

  recordQuizStat: (category, isCorrect) => apiCall("/api/progress/quiz-stat", { method: "POST", body: { category, isCorrect } }),

  recordExam: (examRecord) => apiCall("/api/progress/exam", { method: "POST", body: examRecord }),
};

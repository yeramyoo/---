(() => {
  "use strict";

  const DB_NAME = "study-planner-db";
  const STORE_NAME = "planner";
  const STATE_KEY = "main-state";
  const CLOUD_CONFIG_KEY = "study-planner-cloud-config";
  const SUBJECT_COLORS = {
    "수학": "#56798e", "영어": "#d7684d", "국어": "#8b6ba5",
    "과학": "#4f8a68", "사회": "#c28a3d", "기타": "#77817d"
  };
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const now = new Date();
  let state = {
    tasks: [],
    logs: [],
    pomodoros: 0,
    updatedAt: new Date(0).toISOString()
  };
  let currentPage = 0;
  let calendarView = "month";
  let calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  let selectedDate = dateKey(now);
  let timerMinutes = 25;
  let timerRemaining = timerMinutes * 60;
  let timerInterval = null;
  let syncTimer = null;
  let supabase = null;
  let cloudUser = null;
  let dragStartX = null;
  let dragDelta = 0;

  const els = {
    track: $("#track"), viewport: $("#viewport"), prevPage: $("#prevPage"), nextPage: $("#nextPage"),
    todayTaskList: $("#todayTaskList"), todayEmpty: $("#todayEmpty"), quickAddForm: $("#quickAddForm"),
    progressPercent: $("#progressPercent"), progressRing: $("#progressRing"), progressFraction: $("#progressFraction"),
    progressMessage: $("#progressMessage"), studyLog: $("#studyLog"),
    logEmpty: $("#logEmpty"), todayTotalTime: $("#todayTotalTime"), streakCount: $("#streakCount"),
    calendarContent: $("#calendarContent"), calendarPeriod: $("#calendarPeriod"), selectedDayNumber: $("#selectedDayNumber"),
    selectedDateMeta: $("#selectedDateMeta"), selectedDatePlans: $("#selectedDatePlans"),
    achievementList: $("#achievementList"), achievementEmpty: $("#achievementEmpty"), achievementTotal: $("#achievementTotal"),
    timerDisplay: $("#timerDisplay"), timerStatus: $("#timerStatus"), timerRound: $("#timerRound"),
    timerProgressCircle: $("#timerProgressCircle"), tomatoClock: $("#tomatoClock"), timerStart: $("#timerStart"),
    timerStop: $("#timerStop"), timerConceptInput: $("#timerConceptInput"), timerHint: $("#timerHint"),
    focusLock: $("#focusLock"), lockTime: $("#lockTime"), syncDialog: $("#syncDialog"),
    syncDot: $("#syncDot"), syncLabel: $("#syncLabel"), syncStatus: $("#syncStatus")
  };

  function uid() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function fromDateKey(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }

  function formatMinutes(seconds) {
    if (!seconds) return "0분";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbGet() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbSet(value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(value, STATE_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function persist({ remote = true } = {}) {
    state.updatedAt = new Date().toISOString();
    await dbSet(state).catch(() => {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    });
    if (remote && cloudUser) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(pushCloud, 700);
    }
  }

  async function loadState() {
    try {
      const stored = await dbGet();
      if (stored) state = { ...state, ...stored };
    } catch {
      const fallback = localStorage.getItem(STATE_KEY);
      if (fallback) state = { ...state, ...JSON.parse(fallback) };
    }
    state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    state.logs = Array.isArray(state.logs) ? state.logs : [];
    state.pomodoros = Number(state.pomodoros) || 0;
    restoreTimer();
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    $("#toastRegion").append(toast);
    setTimeout(() => toast.remove(), 2800);
  }

  function renderAll() {
    renderHeader();
    renderToday();
    renderCalendar();
    renderTimer();
    renderAchievements();
  }

  function renderHeader() {
    const today = new Date();
    $("#dateEyebrow").textContent = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 · ${WEEKDAYS[today.getDay()]}요일`;
    $("#todayLabel").textContent = `${today.getMonth() + 1}월 ${today.getDate()}일 ${WEEKDAYS[today.getDay()]}요일`;
  }

  function taskTemplate(task, compact = false) {
    const color = SUBJECT_COLORS[task.subject] || SUBJECT_COLORS["기타"];
    if (compact) {
      return `<div class="date-plan-item" style="--subject:${color}">
        <i></i><div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.subject)} · ${scopeLabel(task.scope)}</small></div>
        <button class="task-delete" type="button" data-delete-task="${task.id}" aria-label="계획 삭제">×</button>
      </div>`;
    }
    return `<article class="task-item${task.completed ? " completed" : ""}" style="--subject:${color}">
      <button class="task-check" type="button" data-toggle-task="${task.id}" aria-label="${task.completed ? "완료 취소" : "계획 완료"}" aria-pressed="${task.completed}">✓</button>
      <div class="task-copy"><strong>${escapeHtml(task.title)}</strong><small><i class="subject-dot"></i>${escapeHtml(task.subject)} · ${scopeLabel(task.scope)}</small></div>
      <button class="task-delete" type="button" data-delete-task="${task.id}" aria-label="계획 삭제">×</button>
    </article>`;
  }

  function scopeLabel(scope) {
    return ({ day: "일간", week: "주간", month: "월간", year: "연간" })[scope] || "일간";
  }

  function renderToday() {
    const today = dateKey(new Date());
    const tasks = state.tasks.filter(task => task.date === today);
    const completed = tasks.filter(task => task.completed).length;
    const progress = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
    els.todayTaskList.innerHTML = tasks.map(task => taskTemplate(task)).join("");
    els.todayEmpty.hidden = tasks.length > 0;
    els.progressPercent.textContent = progress;
    els.progressFraction.textContent = `${completed}/${tasks.length}`;
    els.progressRing.style.setProperty("--progress", progress);
    els.progressRing.setAttribute("aria-label", `오늘의 달성률 ${progress}%`);
    els.progressMessage.textContent = progress === 100 && tasks.length
      ? "오늘 세운 계획을 모두 마쳤어요. 정말 멋져요!"
      : tasks.length ? `${tasks.length - completed}개의 계획이 남아 있어요. 차근차근 해봐요.` : "첫 계획을 적고 오늘의 리듬을 만들어 보세요.";

    const logs = state.logs.filter(log => log.date === today).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const seconds = logs.reduce((sum, log) => sum + (Number(log.seconds) || 0), 0);
    els.todayTotalTime.textContent = formatMinutes(seconds);
    els.logEmpty.hidden = logs.length > 0;
    els.studyLog.innerHTML = logs.map(log => `<article class="log-item">
      <span class="pomo-badge">${log.seconds ? Math.max(1, Math.round(log.seconds / 60)) : "✎"}</span>
      <div class="log-copy"><strong>${escapeHtml(log.concept || "집중 공부")}</strong><small>${log.seconds ? formatMinutes(log.seconds) : "개념 메모"} · ${escapeHtml(log.time || "")}</small></div>
      <button class="log-delete" type="button" data-delete-log="${log.id}" aria-label="기록 삭제">×</button>
    </article>`).join("");
    els.streakCount.textContent = calculateStreak();
  }

  function calculateStreak() {
    const activeDates = new Set([
      ...state.logs.map(log => log.date),
      ...state.tasks.filter(task => task.completed).map(task => task.date)
    ]);
    let streak = 0;
    const cursor = new Date();
    if (!activeDates.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (activeDates.has(dateKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function renderAchievements() {
    const completedTasks = state.tasks.filter(task => task.completed);
    const grouped = completedTasks.reduce((groups, task) => {
      (groups[task.date] ||= []).push(task);
      return groups;
    }, {});
    const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
    els.achievementTotal.textContent = `${completedTasks.length}개 완료`;
    els.achievementEmpty.hidden = dates.length > 0;
    els.achievementList.innerHTML = dates.map(key => {
      const date = fromDateKey(key);
      const allTasks = state.tasks.filter(task => task.date === key);
      const items = grouped[key]
        .sort((a, b) => String(b.completedAt || b.createdAt).localeCompare(String(a.completedAt || a.createdAt)))
        .map(task => `<div class="achievement-item">
          <span class="achievement-check" aria-hidden="true">✓</span>
          <strong>${escapeHtml(task.title)}</strong>
          <small>${escapeHtml(task.subject)} · ${scopeLabel(task.scope)}</small>
        </div>`).join("");
      return `<section class="achievement-day">
        <button class="achievement-day-head" type="button" data-open-date="${key}" aria-label="${date.getMonth() + 1}월 ${date.getDate()}일 달력에서 보기">
          <span class="achievement-date"><span class="achievement-date-number">${date.getDate()}</span><span><strong>${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일</strong><small>${WEEKDAYS[date.getDay()]}요일 · 달력에서 보기</small></span></span>
          <span class="achievement-day-summary">${grouped[key].length}/${allTasks.length} 완료 →</span>
        </button>
        <div class="achievement-items">${items}</div>
      </section>`;
    }).join("");
  }

  function renderCalendar() {
    $$(".view-tabs button").forEach(button => button.setAttribute("aria-selected", String(button.dataset.view === calendarView)));
    if (calendarView === "month") renderMonth();
    if (calendarView === "week") renderWeek();
    if (calendarView === "year") renderYear();
    renderSelectedDate();
  }

  function renderMonth() {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    els.calendarPeriod.textContent = `${year}년 ${month + 1}월`;
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dateKey(date);
      const tasks = state.tasks.filter(task => task.date === key);
      const markers = tasks.slice(0, 4).map(task => `<i class="day-marker" style="--subject:${SUBJECT_COLORS[task.subject] || SUBJECT_COLORS["기타"]}"></i>`).join("");
      cells.push(`<button class="day-cell${date.getMonth() !== month ? " outside" : ""}${key === selectedDate ? " selected" : ""}${key === dateKey(new Date()) ? " today" : ""}" type="button" data-date="${key}">
        <span class="day-number">${date.getDate()}</span><span class="day-markers">${markers}${tasks.length > 4 ? `<em class="day-more">+${tasks.length - 4}</em>` : ""}</span>
      </button>`);
    }
    els.calendarContent.innerHTML = `<div class="weekday-row">${WEEKDAYS.map(day => `<span>${day}</span>`).join("")}</div><div class="month-grid">${cells.join("")}</div>`;
  }

  function startOfWeek(date) {
    const result = new Date(date);
    result.setDate(result.getDate() - result.getDay());
    result.setHours(0, 0, 0, 0);
    return result;
  }

  function renderWeek() {
    const start = startOfWeek(calendarCursor);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    els.calendarPeriod.textContent = start.getMonth() === end.getMonth()
      ? `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}–${end.getDate()}일`
      : `${start.getMonth() + 1}월 ${start.getDate()}일 – ${end.getMonth() + 1}월 ${end.getDate()}일`;
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(start); date.setDate(start.getDate() + i);
      const key = dateKey(date);
      const tasks = state.tasks.filter(task => task.date === key);
      days.push(`<button class="week-day${key === selectedDate ? " selected" : ""}" type="button" data-date="${key}">
        <small>${WEEKDAYS[date.getDay()]}요일</small><strong>${date.getDate()}</strong>
        ${tasks.map(task => `<span class="week-plan" style="--subject:${SUBJECT_COLORS[task.subject] || SUBJECT_COLORS["기타"]}">${escapeHtml(task.title)}</span>`).join("")}
      </button>`);
    }
    els.calendarContent.innerHTML = `<div class="week-grid">${days.join("")}</div>`;
  }

  function renderYear() {
    const year = calendarCursor.getFullYear();
    els.calendarPeriod.textContent = `${year}년`;
    const months = [];
    for (let month = 0; month < 12; month += 1) {
      const firstDay = new Date(year, month, 1).getDay();
      const lastDate = new Date(year, month + 1, 0).getDate();
      const days = Array.from({ length: firstDay }, () => `<span class="mini-day blank"></span>`);
      for (let day = 1; day <= lastDate; day += 1) {
        const key = dateKey(new Date(year, month, day));
        const hasPlan = state.tasks.some(task => task.date === key);
        days.push(`<button class="mini-day${hasPlan ? " has-plan" : ""}${key === selectedDate ? " selected" : ""}" type="button" data-date="${key}" aria-label="${month + 1}월 ${day}일">${day}</button>`);
      }
      months.push(`<section class="mini-month"><h3>${month + 1}월</h3><div class="mini-days">${days.join("")}</div></section>`);
    }
    els.calendarContent.innerHTML = `<div class="year-grid">${months.join("")}</div>`;
  }

  function renderSelectedDate() {
    const date = fromDateKey(selectedDate);
    els.selectedDayNumber.textContent = date.getDate();
    els.selectedDateMeta.textContent = `${date.getFullYear()}년 ${date.getMonth() + 1}월 · ${WEEKDAYS[date.getDay()]}요일`;
    const tasks = state.tasks.filter(task => task.date === selectedDate);
    els.selectedDatePlans.innerHTML = tasks.length
      ? tasks.map(task => taskTemplate(task, true)).join("")
      : `<p class="log-empty">이 날짜에는 아직 계획이 없어요.</p>`;
  }

  function renderTimer() {
    const running = Boolean(state.timer?.running);
    const total = state.timer?.duration || timerMinutes * 60;
    const remaining = running ? getRemainingSeconds() : timerRemaining;
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const text = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    els.timerDisplay.textContent = text;
    els.lockTime.textContent = text;
    els.timerStatus.textContent = running ? (state.timer.mode === "focus" ? "집중 중" : "휴식 중") : "준비";
    els.timerRound.textContent = `오늘 ${todayPomodoros()}번째 뽀모도로`;
    const ratio = total ? 1 - remaining / total : 0;
    els.timerProgressCircle.style.strokeDashoffset = String(678.6 * (1 - ratio));
    els.tomatoClock.classList.toggle("running", running);
    els.timerStart.hidden = running;
    els.timerStop.hidden = !running;
    els.timerConceptInput.disabled = running;
    $$("#timerModeTabs button").forEach(button => {
      button.disabled = running;
      button.classList.toggle("active", Number(button.dataset.minutes) === timerMinutes);
    });
    els.timerHint.textContent = running
      ? "집중 중에는 오늘·달력 화면이 잠깁니다. 종료하면 공부 기록에 저장돼요."
      : `${timerMinutes}분 동안 알림을 내려놓고 한 가지에 집중해 보세요.`;
    updateNavigationLock(running);
  }

  function todayPomodoros() {
    return state.logs.filter(log => log.date === dateKey(new Date()) && log.completedPomodoro).length;
  }

  function getRemainingSeconds() {
    if (!state.timer?.running) return timerRemaining;
    return Math.max(0, Math.ceil((state.timer.endsAt - Date.now()) / 1000));
  }

  function startTimer() {
    if (state.timer?.running) return;
    const duration = timerMinutes * 60;
    const mode = timerMinutes === 25 ? "focus" : "break";
    state.timer = {
      running: true, duration, startedAt: Date.now(), endsAt: Date.now() + duration * 1000,
      concept: els.timerConceptInput.value.trim(), mode
    };
    persist();
    goToPage(2, true);
    startTimerLoop();
    renderTimer();
    showToast(mode === "focus" ? "집중 모드를 시작했어요." : "휴식 타이머를 시작했어요.");
  }

  function startTimerLoop() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!state.timer?.running) return clearInterval(timerInterval);
      if (getRemainingSeconds() <= 0) finishTimer(true);
      else renderTimer();
    }, 500);
  }

  async function finishTimer(completed) {
    if (!state.timer?.running) return;
    const timer = { ...state.timer };
    const elapsed = Math.min(timer.duration, Math.max(0, Math.round((Date.now() - timer.startedAt) / 1000)));
    clearInterval(timerInterval);
    delete state.timer;
    timerRemaining = timerMinutes * 60;
    if (timer.mode === "focus" && elapsed >= 60) {
      state.logs.push({
        id: uid(), date: dateKey(new Date()), concept: timer.concept || "집중 공부",
        seconds: completed ? timer.duration : elapsed, createdAt: new Date().toISOString(),
        time: new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date()),
        completedPomodoro: completed
      });
    }
    await persist();
    renderAll();
    showToast(completed ? (timer.mode === "focus" ? "뽀모도로 완료! 공부 기록에 저장했어요." : "휴식이 끝났어요.") : (elapsed >= 60 && timer.mode === "focus" ? "지금까지의 집중 시간을 저장했어요." : "타이머를 종료했어요."));
  }

  function restoreTimer() {
    if (!state.timer?.running) return;
    timerMinutes = Math.round(state.timer.duration / 60);
    if (getRemainingSeconds() <= 0) {
      finishTimer(true);
    } else {
      startTimerLoop();
      currentPage = 2;
    }
  }

  function updateNavigationLock(locked) {
    $$(".bottom-nav button, .brand").forEach(button => {
      if (button.id === "nextPage" || button.id === "prevPage" || button.matches("[data-page], [data-go]")) {
        button.setAttribute("aria-disabled", String(locked));
      }
    });
  }

  function showFocusLock() {
    els.focusLock.hidden = false;
    setTimeout(() => els.focusLock.hidden = true, 2200);
  }

  function goToPage(index, force = false) {
    const target = Math.max(0, Math.min(3, index));
    if (state.timer?.running && target !== 2 && !force) {
      showFocusLock();
      return;
    }
    currentPage = target;
    els.track.style.transform = `translateX(-${currentPage * 25}%)`;
    $$(".page-dots button").forEach((button, i) => {
      button.classList.toggle("active", i === currentPage);
      button.setAttribute("aria-selected", String(i === currentPage));
    });
    els.prevPage.disabled = currentPage === 0 || Boolean(state.timer?.running);
    els.nextPage.disabled = currentPage === 3 || Boolean(state.timer?.running);
  }

  async function addTask({ title, subject = "기타", date = dateKey(new Date()), scope = "day" }) {
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) return null;
    const task = { id: uid(), title: cleanTitle.slice(0, 100), subject, date, scope, completed: false, createdAt: new Date().toISOString() };
    state.tasks.push(task);
    await persist();
    renderAll();
    return task;
  }

  async function toggleTask(id) {
    const task = state.tasks.find(item => item.id === id);
    if (!task) return;
    task.completed = !task.completed;
    task.completedAt = task.completed ? new Date().toISOString() : null;
    await persist();
    renderAll();
    if (task.completed) showToast("계획 완료! 오늘의 달성률이 올라갔어요.");
  }

  async function deleteTask(id) {
    state.tasks = state.tasks.filter(task => task.id !== id);
    await persist();
    renderAll();
  }

  function bindEvents() {
    $("#quickAddToggle").addEventListener("click", () => {
      els.quickAddForm.hidden = !els.quickAddForm.hidden;
      if (!els.quickAddForm.hidden) $("#quickTaskInput").focus();
    });
    els.quickAddForm.addEventListener("submit", async event => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      await addTask({ title: form.get("title"), subject: form.get("subject") });
      formElement.reset();
      $("#quickTaskInput").focus();
    });
    $("#conceptForm").addEventListener("submit", async event => {
      event.preventDefault();
      const input = $("#conceptInput");
      const concept = input.value.trim();
      if (!concept) return;
      state.logs.push({ id: uid(), date: dateKey(new Date()), concept, seconds: 0, createdAt: new Date().toISOString(), time: "직접 기록", completedPomodoro: false });
      input.value = "";
      await persist();
      renderToday();
      showToast("공부한 개념을 기록했어요.");
    });
    document.addEventListener("click", event => {
      const toggle = event.target.closest("[data-toggle-task]");
      const removeTask = event.target.closest("[data-delete-task]");
      const removeLog = event.target.closest("[data-delete-log]");
      const dateButton = event.target.closest("[data-date]");
      const achievementDate = event.target.closest("[data-open-date]");
      if (toggle) toggleTask(toggle.dataset.toggleTask);
      if (removeTask) deleteTask(removeTask.dataset.deleteTask);
      if (removeLog) {
        state.logs = state.logs.filter(log => log.id !== removeLog.dataset.deleteLog);
        persist().then(renderToday);
      }
      if (dateButton) {
        selectedDate = dateButton.dataset.date;
        calendarCursor = fromDateKey(selectedDate);
        renderCalendar();
      }
      if (achievementDate) {
        selectedDate = achievementDate.dataset.openDate;
        calendarCursor = fromDateKey(selectedDate);
        goToPage(1);
        renderCalendar();
      }
    });
    $("#datePlanForm").addEventListener("submit", async event => {
      event.preventDefault();
      await addTask({
        title: $("#datePlanInput").value,
        subject: $("#datePlanSubject").value,
        date: selectedDate,
        scope: $("#datePlanScope").value
      });
      $("#datePlanInput").value = "";
      showToast("선택한 날짜에 계획을 저장했어요.");
    });
    $$(".view-tabs button").forEach(button => button.addEventListener("click", () => {
      calendarView = button.dataset.view;
      calendarCursor = fromDateKey(selectedDate);
      renderCalendar();
    }));
    $("#calendarPrev").addEventListener("click", () => moveCalendar(-1));
    $("#calendarNext").addEventListener("click", () => moveCalendar(1));
    els.calendarPeriod.addEventListener("click", () => {
      calendarCursor = new Date(); selectedDate = dateKey(new Date()); renderCalendar();
    });
    $$("#timerModeTabs button").forEach(button => button.addEventListener("click", () => {
      timerMinutes = Number(button.dataset.minutes);
      timerRemaining = timerMinutes * 60;
      renderTimer();
    }));
    els.timerStart.addEventListener("click", startTimer);
    els.timerStop.addEventListener("click", () => finishTimer(false));
    $("#returnToTimer").addEventListener("click", () => { els.focusLock.hidden = true; goToPage(2, true); });
    $$("[data-page]").forEach(button => button.addEventListener("click", () => goToPage(Number(button.dataset.page))));
    $$("[data-go]").forEach(button => button.addEventListener("click", () => goToPage(Number(button.dataset.go))));
    els.prevPage.addEventListener("click", () => goToPage(currentPage - 1));
    els.nextPage.addEventListener("click", () => goToPage(currentPage + 1));
    bindSwipe();
    bindCloudEvents();
    window.addEventListener("beforeunload", event => {
      if (state.timer?.running) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.timer?.running) renderTimer();
    });
  }

  function moveCalendar(direction) {
    if (calendarView === "month") calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + direction, 1);
    if (calendarView === "week") calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), calendarCursor.getDate() + direction * 7);
    if (calendarView === "year") calendarCursor = new Date(calendarCursor.getFullYear() + direction, 0, 1);
    renderCalendar();
  }

  function bindSwipe() {
    els.viewport.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target.closest("input, textarea, select, button, dialog") || state.timer?.running) return;
      dragStartX = event.clientX; dragDelta = 0;
      els.track.classList.add("dragging");
      els.viewport.setPointerCapture?.(event.pointerId);
    });
    els.viewport.addEventListener("pointermove", event => {
      if (dragStartX === null) return;
      dragDelta = event.clientX - dragStartX;
      const width = els.viewport.clientWidth;
      const base = -currentPage * width;
      const resistance = (currentPage === 0 && dragDelta > 0) || (currentPage === 3 && dragDelta < 0) ? .22 : 1;
      els.track.style.transform = `translateX(${base + dragDelta * resistance}px)`;
    });
    const endDrag = () => {
      if (dragStartX === null) return;
      els.track.classList.remove("dragging");
      if (Math.abs(dragDelta) > Math.min(90, els.viewport.clientWidth * .18)) goToPage(currentPage + (dragDelta < 0 ? 1 : -1));
      else goToPage(currentPage, true);
      dragStartX = null; dragDelta = 0;
    };
    els.viewport.addEventListener("pointerup", endDrag);
    els.viewport.addEventListener("pointercancel", endDrag);
  }

  function bindCloudEvents() {
    $("#syncButton").addEventListener("click", () => {
      const config = readCloudConfig();
      $("#supabaseUrl").value = config.url || "";
      $("#supabaseKey").value = config.key || "";
      $("#syncEmail").value = config.email || "";
      els.syncDialog.showModal();
    });
    $("#saveSyncConfig").addEventListener("click", async () => {
      const config = getCloudFormValues();
      if (!config.url || !config.key) return showToast("프로젝트 URL과 Anon 키를 입력해 주세요.");
      localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
      setSyncState("syncing", "연결 확인 중");
      await initCloud();
    });
    $("#sendMagicLink").addEventListener("click", async () => {
      const config = getCloudFormValues();
      if (!config.email) return showToast("로그인 이메일을 입력해 주세요.");
      if (!supabase) {
        localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
        await initCloud();
      }
      if (!supabase) return;
      const { error } = await supabase.auth.signInWithOtp({ email: config.email, options: { emailRedirectTo: location.href.split("#")[0] } });
      if (error) setDialogStatus(`로그인 링크를 보내지 못했어요: ${error.message}`);
      else setDialogStatus("이메일을 확인해 로그인 링크를 눌러 주세요. 같은 이메일을 두 기기에서 사용하면 됩니다.");
    });
  }

  function getCloudFormValues() {
    return { url: $("#supabaseUrl").value.trim().replace(/\/$/, ""), key: $("#supabaseKey").value.trim(), email: $("#syncEmail").value.trim() };
  }

  function readCloudConfig() {
    try { return JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY)) || {}; } catch { return {}; }
  }

  function setSyncState(kind, label) {
    els.syncDot.className = `sync-dot${kind ? ` ${kind}` : ""}`;
    els.syncLabel.textContent = label;
  }

  function setDialogStatus(message) {
    els.syncStatus.textContent = message;
  }

  async function initCloud() {
    const config = readCloudConfig();
    if (!config.url || !config.key) return;
    try {
      setSyncState("syncing", "동기화 중");
      const module = await import("https://esm.sh/@supabase/supabase-js@2");
      supabase = module.createClient(config.url, config.key, { auth: { persistSession: true, detectSessionInUrl: true } });
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      cloudUser = data.session?.user || null;
      supabase.auth.onAuthStateChange((_event, session) => {
        cloudUser = session?.user || null;
        if (cloudUser) syncCloud();
        else setSyncState("", "로그인 필요");
      });
      if (cloudUser) await syncCloud();
      else {
        setSyncState("", "로그인 필요");
        setDialogStatus("연결 정보가 저장됐어요. 이메일 로그인 링크를 받아 로그인해 주세요.");
      }
    } catch (error) {
      supabase = null; cloudUser = null;
      setSyncState("", "오프라인 저장");
      setDialogStatus(`클라우드 연결을 확인해 주세요: ${error.message || "알 수 없는 오류"}`);
    }
  }

  async function syncCloud() {
    if (!supabase || !cloudUser) return;
    setSyncState("syncing", "동기화 중");
    const { data, error } = await supabase.from("planner_data").select("payload, updated_at").eq("user_id", cloudUser.id).maybeSingle();
    if (error) {
      setSyncState("", "동기화 오류");
      setDialogStatus(`planner_data 테이블 설정을 확인해 주세요: ${error.message}`);
      return;
    }
    if (data?.payload && new Date(data.payload.updatedAt || data.updated_at) > new Date(state.updatedAt)) {
      state = { ...state, ...data.payload };
      await dbSet(state);
      renderAll();
    } else {
      await pushCloud();
    }
    setSyncState("online", "클라우드 동기화됨");
    setDialogStatus(`${cloudUser.email || "현재 계정"}으로 동기화 중입니다.`);
  }

  async function pushCloud() {
    if (!supabase || !cloudUser) return;
    setSyncState("syncing", "동기화 중");
    const { error } = await supabase.from("planner_data").upsert({ user_id: cloudUser.id, payload: state, updated_at: state.updatedAt });
    if (error) {
      setSyncState("", "동기화 오류");
      setDialogStatus(`저장하지 못했어요: ${error.message}`);
    } else {
      setSyncState("online", "클라우드 동기화됨");
    }
  }

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const register = tool => Promise.resolve(context.registerTool(tool)).catch(() => {});
    register({
      name: "get_today_study_summary", title: "오늘 공부 현황 보기",
      description: "오늘의 공부 계획, 완료 수, 달성률과 집중 시간을 조회합니다.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => {
        const today = dateKey(new Date());
        const tasks = state.tasks.filter(task => task.date === today);
        const done = tasks.filter(task => task.completed).length;
        return { date: today, totalPlans: tasks.length, completedPlans: done, progressPercent: tasks.length ? Math.round(done / tasks.length * 100) : 0, focusSeconds: state.logs.filter(log => log.date === today).reduce((sum, log) => sum + (log.seconds || 0), 0) };
      }
    });
    register({
      name: "create_study_plan", title: "공부 계획 추가",
      description: "지정한 날짜에 새로운 공부 계획을 추가합니다.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, subject: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, scope: { type: "string", enum: ["day", "week", "month", "year"] } }, required: ["title", "date"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async input => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("날짜는 YYYY-MM-DD 형식이어야 합니다.");
        const task = await addTask(input);
        return { created: true, task };
      }
    });
    register({
      name: "complete_study_plan", title: "공부 계획 완료",
      description: "계획 ID에 해당하는 공부 계획을 완료 처리합니다.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async input => {
        const task = state.tasks.find(item => item.id === input.id);
        if (!task) throw new Error("계획을 찾을 수 없습니다.");
        if (!task.completed) await toggleTask(task.id);
        return { completed: true, id: task.id };
      }
    });
  }

  async function init() {
    await loadState();
    bindEvents();
    renderAll();
    goToPage(state.timer?.running ? 2 : 0, true);
    registerWebMcpTools();
    initCloud();
  }

  init();
})();

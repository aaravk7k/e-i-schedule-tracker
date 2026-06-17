const app = {
  data: null,
  view: "space-calendar",
  selectedWorkerId: "",
  spaceCalendar: {
    space: "",
    workerId: ""
  },
  editingSchedule: null,
  toastTimer: null
};

const staffViews = [
  ["space-calendar", "Space Calendar"],
  ["schedules", "Coverage"],
  ["events", "Bookings"],
  ["people", "People"],
  ["spaces", "Spaces"],
  ["access", "Access"]
];

const studentViews = [
  ["space-calendar", "My Space Calendar"],
  ["requests", "Requests"],
  ["profile", "My Schedule"],
  ["schedules", "Coverage"]
];

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("resetDataBtn").addEventListener("click", resetDemo);
  document.getElementById("focusDateInput").addEventListener("change", setFocusDate);
  loadState();
});

async function loadState() {
  const response = await fetch("/api/state");
  if (response.status === 401) {
    app.data = null;
    renderLogin();
    return;
  }
  app.data = await response.json();
  app.selectedWorkerId = app.selectedWorkerId || app.data.currentUser.workerId || app.data.workers[0]?.id || "";
  app.view = defaultViewForRole(app.data.role);
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) renderLogin();
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function renderLogin() {
  document.querySelector(".sidebar").classList.add("login-sidebar");
  document.getElementById("viewTitle").textContent = "Sign In";
  document.querySelector(".topbar-actions").classList.add("hidden");
  document.getElementById("primaryNav").innerHTML = "";
  document.getElementById("appView").innerHTML = `
    <section class="login-panel">
      <div>
        <p class="eyebrow">Edson E+I Schedule Manager</p>
        <h3>Sign in to continue</h3>
        <p class="microcopy">One simple place to see who is covering each space, what is missing, and which student should be asked.</p>
      </div>
      <form id="loginForm" class="login-form">
        <label>
          Email
          <input name="email" type="email" autocomplete="username" required placeholder="staff@ei.asu.edu">
        </label>
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" required placeholder="Password">
        </label>
        <button class="primary-button" type="submit">Sign In</button>
      </form>
      <div class="demo-logins">
        <strong>Local demo accounts</strong>
        <span>Staff: staff@ei.asu.edu / edson-staff</span>
        <span>Student: aarav-kapoor@ei.asu.edu / edson-student</span>
      </div>
    </section>
  `;

  document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: { email: form.get("email"), password: form.get("password") }
      });
      showToast(`Signed in as ${result.user.name}.`);
      await refreshState();
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function refreshState(keepView = true) {
  const priorView = app.view;
  const data = await api("/api/state");
  app.data = data;
  if (keepView && availableViews().some(([id]) => id === priorView)) app.view = priorView;
  else app.view = defaultViewForRole(data.role);
  if (!data.workers.some((worker) => worker.id === app.selectedWorkerId)) {
    app.selectedWorkerId = data.currentUser.workerId || data.workers[0]?.id || "";
  }
  render();
}

function render() {
  if (!app.data) {
    renderLogin();
    return;
  }
  document.querySelector(".sidebar").classList.remove("login-sidebar");
  document.querySelector(".topbar-actions").classList.remove("hidden");
  document.getElementById("resetDataBtn").classList.toggle("hidden", app.data.role !== "staff");
  document.getElementById("focusDateInput").value = app.data.focusDate;
  renderNav();

  const viewTitle = availableViews().find(([id]) => id === app.view)?.[1] || "Schedule Manager";
  document.getElementById("viewTitle").textContent = viewTitle;
  const region = document.getElementById("appView");

  if (app.data.role === "staff" && app.view === "dashboard") region.innerHTML = renderStaffDashboard();
  if (app.data.role === "staff" && app.view === "tasks") region.innerHTML = renderTaskManager();
  if (app.data.role === "staff" && app.view === "events") region.innerHTML = renderEvents();
  if (app.data.role === "staff" && app.view === "people") region.innerHTML = renderPeople();
  if (app.data.role === "staff" && app.view === "access") region.innerHTML = renderAccess();
  if (app.view === "space-calendar") region.innerHTML = renderSpaceCalendar();
  if (app.view === "my-tasks") region.innerHTML = renderMyTasks();
  if (app.view === "requests") region.innerHTML = renderRequests();
  if (app.view === "profile") region.innerHTML = renderProfile();
  if (app.view === "schedules") region.innerHTML = renderSchedules();
  if (app.view === "spaces") region.innerHTML = renderSpaces();

  bindEvents();
}

function renderNav() {
  document.getElementById("primaryNav").innerHTML = availableViews()
    .map(([id, label]) => `<button class="nav-button ${app.view === id ? "active" : ""}" type="button" data-view="${id}">${label}</button>`)
    .join("");
}

function availableViews() {
  return app.data?.role === "staff" ? staffViews : studentViews;
}

function defaultViewForRole() {
  return "space-calendar";
}

function renderStaffDashboard() {
  const tasks = app.data.tasks || [];
  const openTasks = tasks.filter((task) => ["pending", "accepted", "unassigned"].includes(task.status));
  const done = tasks.filter((task) => task.status === "done").length;
  const alerts = app.data.alerts || [];
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Operations</p>
          <h3>Today at a glance</h3>
        </div>
        <div class="action-row">
          <button class="primary-button" type="button" data-action="open-task-form">New Task</button>
          <button class="secondary-button" type="button" data-action="rerun-ai">Assign Open Tasks</button>
        </div>
      </div>
      <div class="kpi-grid">
        ${kpiCard(openTasks.length, "Open tasks")}
        ${kpiCard(tasks.filter((task) => task.status === "pending").length, "Waiting on students")}
        ${kpiCard(done, "Completed")}
        ${kpiCard(app.data.coverageGaps.length, "Coverage alerts")}
      </div>
    </section>

    <section class="split-grid">
      <div class="panel">
        <h3>Important Alerts</h3>
        ${alerts.length ? `<div class="alert-stack">${alerts.slice(0, 8).map(alertCard).join("")}</div>` : emptyState("No coverage or schedule alerts.")}
      </div>
      <div class="panel">
        <h3>Open Tasks</h3>
        ${openTasks.length ? `<div class="task-list">${openTasks.slice(0, 8).map(taskCard).join("")}</div>` : emptyState("No open tasks.")}
      </div>
    </section>

    <section class="panel flush">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Student</th><th>Skills</th><th>Active Tasks</th><th>Schedule Blocks</th></tr></thead>
          <tbody>${app.data.workers.map(workerSummaryRow).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderTaskManager() {
  return `
    <section class="split-grid">
      <div class="panel">
        <h3>Create Task</h3>
        ${taskForm()}
      </div>
      <div class="panel">
        <h3>Paste Event List</h3>
        <form id="eventForm" class="form-grid">
          <label class="span-6">
            Events
            <textarea name="events" required placeholder="Pitch In | 2026-04-24 | 1951@SkySong | 5:00PM | 7:30PM | Front Desk, Event Coverage"></textarea>
          </label>
          <div class="span-6 action-row">
            <button class="primary-button" type="submit">Create Coverage Tasks</button>
          </div>
        </form>
      </div>
    </section>

    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Task Board</p>
          <h3>All Staff-Managed Tasks</h3>
        </div>
        <div class="action-row">
          <button class="secondary-button" type="button" data-action="generate-worldlabs">Generate WorldLabs Tasks</button>
          <button class="secondary-button" type="button" data-action="rerun-ai">Assign Open Tasks</button>
        </div>
      </div>
      <div class="task-list">${app.data.tasks.map(taskCard).join("")}</div>
    </section>
  `;
}

function renderPeople() {
  return `
    <section class="split-grid">
      <div class="panel">
        <h3>Add Student</h3>
        <form id="workerForm" class="form-grid">
          <label class="span-2">Name<input name="name" required placeholder="Student name"></label>
          <label>Initials<input name="initials" maxlength="5" placeholder="AK"></label>
          <label class="span-2">Email<input name="email" type="email" placeholder="student@asu.edu"></label>
          <label class="span-2">Primary Space${spaceSelect("primarySpace")}</label>
          <fieldset class="span-6 checkbox-panel">
            <legend>Skills</legend>
            <div class="check-grid">${skillCheckboxes(["customer-service", "coverage"], "skills")}</div>
          </fieldset>
          <div class="span-6 action-row"><button class="primary-button" type="submit">Add Student</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>Students</h3>
        <div class="task-list">${app.data.workers.map(workerCard).join("")}</div>
      </div>
    </section>
  `;
}

function renderAccess() {
  const users = app.data.users || [];
  const storage = app.data.storage || {};
  const storageTitle = storage.shared ? "Shared Airtable backend" : "Local prototype storage";
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Pilot Storage</p>
          <h3>${escapeHtml(storageTitle)}</h3>
          <p class="microcopy">${storage.shared ? `Everyone using the deployed app reads and writes the same Airtable state table: ${escapeHtml(storage.stateTable)}.` : "This copy is using local JSON. Set AIRTABLE_BACKEND=true before sharing one hosted version with the department."}</p>
        </div>
        <div class="badge-row">
          <span class="status-pill ${storage.shared ? "scheduled" : "draft"}">${storage.shared ? "Shared" : "Local"}</span>
          ${storage.baseId ? `<span class="badge">${escapeHtml(storage.baseId)}</span>` : ""}
        </div>
      </div>
      ${storage.lastStateSaveError ? `<div class="alert-card warning"><strong>Airtable save issue</strong><span>${escapeHtml(storage.lastStateSaveError)}</span></div>` : ""}
    </section>
    <section class="split-grid">
      <div class="panel">
        <h3>Create Test Login</h3>
        <form id="userForm" class="form-grid">
          <label class="span-2">Name<input name="name" placeholder="Staff name"></label>
          <label class="span-2">Email<input name="email" type="email" required placeholder="person@asu.edu"></label>
          <label>Role
            <select name="role">
              <option value="staff">Staff</option>
              <option value="student">Student worker</option>
            </select>
          </label>
          <label class="span-2">Student profile${workerSelectWithBlank("")}</label>
          <label class="span-2">Temporary password<input name="password" type="text" required minlength="8" placeholder="At least 8 characters"></label>
          <div class="span-6 action-row"><button class="primary-button" type="submit">Save Login</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>Current Logins</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Student Profile</th></tr></thead>
            <tbody>${users.map(userRow).join("")}</tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderMyTasks() {
  const tasks = app.data.tasks || [];
  const active = tasks.filter((task) => task.status !== "done");
  const done = tasks.filter((task) => task.status === "done");
  const worker = currentWorker();
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Student Workspace</p>
          <h3>${escapeHtml(app.data.currentUser.name)}</h3>
        </div>
      </div>
      <div class="kpi-grid">
        ${kpiCard(active.filter((task) => task.status === "pending").length, "Need response")}
        ${kpiCard(active.filter((task) => task.status === "accepted").length, "Accepted")}
        ${kpiCard(done.length, "Completed")}
        ${kpiCard(app.data.coverageGaps.length, "Space alerts")}
      </div>
    </section>
    ${studentHoursSummaryPanel(worker)}
    <section class="split-grid">
      <div class="panel">
        <h3>My Assigned Tasks</h3>
        ${active.length ? `<div class="task-list">${active.map(taskCard).join("")}</div>` : emptyState("No active tasks assigned to you.")}
      </div>
      <div class="panel">
        <h3>Shared Space Alerts</h3>
        ${app.data.alerts?.length ? `<div class="alert-stack">${app.data.alerts.slice(0, 6).map(alertCard).join("")}</div>` : emptyState("No space alerts right now.")}
      </div>
    </section>
  `;
}

function studentHoursSummaryPanel(worker) {
  if (!worker) return "";
  const rows = DAYS.map((day, index) => {
    const date = addDays(app.data.focusWeekStart, index);
    const slots = (worker.availability || []).filter((slot) => scheduleItemMatchesDate(slot, day, date));
    const hours = slots.reduce((sum, slot) => sum + paidHoursForRange(slot.start, slot.end), 0);
    return { day, date, slots, hours };
  });
  const total = rows.reduce((sum, row) => sum + row.hours, 0);
  const limit = worker.weeklyLimit || 40;
  return `
    <section class="panel">
      <div class="band-header compact-header">
        <div>
          <p class="eyebrow">Workday Check</p>
          <h3>My Hours This Week</h3>
        </div>
        <strong class="hours-summary-total">${formatHours(total)} / ${formatHours(limit)} hours</strong>
      </div>
      <div class="hours-summary-grid">
        ${rows.map((row) => `
          <article class="hours-summary-card">
            <strong>${row.day.slice(0, 3)}</strong>
            <span>${formatShortDate(row.date)}</span>
            <b>${formatHours(row.hours)}h</b>
            <em>${row.slots.length ? row.slots.map((slot) => `${formatTime(slot.start)}-${formatTime(slot.end)}`).join(", ") : "Off"}</em>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderProfile() {
  const worker = currentWorker();
  if (!worker) return emptyState("No student profile linked to this login.");
  const availability = availabilityInFocusWeek(worker);
  return `
    <section class="split-grid">
      <div class="panel">
        <h3>My Availability</h3>
        ${weeklyHourPanel(worker)}
        <div class="task-list">${availability.length ? availability.map(({ slot, index }) => scheduleMiniCard(slot, worker, index, true)).join("") : emptyState("No schedule blocks this week.")}</div>
        ${scheduleForm(worker.id, false)}
      </div>
      <div class="panel">
        <h3>My Skills</h3>
        <form id="skillForm" class="skill-form" data-worker-id="${worker.id}">
          <div class="check-grid">${skillCheckboxes(worker.skills, "skills")}</div>
          <label class="stacked-field">Add Other Skill<input name="customSkills" placeholder="Canva, inventory, email replies"></label>
          <div class="action-row"><button class="primary-button" type="submit">Save Skills</button></div>
        </form>
      </div>
    </section>
  `;
}

function weeklyHourPanel(worker) {
  const limit = worker.weeklyLimit || 20;
  const hours = Number(worker.weeklyHours || 0);
  const remaining = Math.max(0, limit - hours);
  const percent = Math.min(100, (hours / limit) * 100);
  const over = hours > limit;
  return `
    <div class="hour-meter ${over ? "over" : ""}">
      <div class="hour-meter-head">
        <strong>${formatHours(hours)} / ${formatHours(limit)} hours</strong>
        <span>${over ? "Over weekly limit" : `${formatHours(remaining)} hours left`}</span>
      </div>
      <div class="hour-bar"><span style="width:${percent}%"></span></div>
      <p class="task-meta">Student workers should stay within the configured weekly limit.</p>
    </div>
  `;
}

function currentSpaceCalendarContext() {
  const staff = app.data.role === "staff";
  const workerFilter = staff ? app.spaceCalendar.workerId : app.data.currentUser.workerId;
  const spaceFilter = staff ? app.spaceCalendar.space : "";
  const visibleSpaces = calendarVisibleSpaces(spaceFilter, workerFilter);
  const workerName = workerFilter ? workerById(workerFilter)?.name || "" : "";
  return {
    staff,
    workerFilter,
    workerName,
    spaceFilter,
    visibleSpaces,
    visibleSpaceSet: new Set(visibleSpaces),
    weekStart: app.data.focusWeekStart,
    weekEnd: addDays(app.data.focusWeekStart, 6),
    title: staff ? "Space Calendar" : "My Space Calendar"
  };
}

function renderSpaceCalendar() {
  const context = currentSpaceCalendarContext();
  const staff = context.staff;
  const workerFilter = context.workerFilter;
  const visibleSpaces = context.visibleSpaces;
  const visibleSpaceSet = context.visibleSpaceSet;
  const focusEvents = eventsInFocusWeek(app.data.events || []).filter((event) => visibleSpaceSet.has(event.space));
  const visibleRequests = requestsInFocusWeek(app.data.coverageRequests || []).filter((request) => {
    const event = eventById(request.eventId);
    if (!event || !visibleSpaceSet.has(event.space)) return false;
    return staff || request.workerId === app.data.currentUser.workerId;
  });
  const visibleGaps = (app.data.coverageGaps || []).filter((gap) => visibleSpaceSet.has(gap.space));
  const visibleShiftCount = DAYS.reduce((sum, day, index) => {
    const date = addDays(app.data.focusWeekStart, index);
    return sum + calendarShiftItems(day, date, visibleSpaceSet, workerFilter).length;
  }, 0);

  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">${staff ? "Staff Planning" : "Student View"}</p>
          <h3>${staff ? "Space Calendar" : "My Space Calendar"}</h3>
        </div>
        <div class="badge-row">${visibleSpaces.map(spaceChip).join("") || `<span class="badge">No space selected</span>`}</div>
      </div>
      <div class="kpi-grid">
        ${kpiCard(visibleSpaces.length, staff ? "Spaces shown" : "My spaces")}
        ${kpiCard(visibleShiftCount, staff ? "Schedule blocks" : "My shifts")}
        ${kpiCard(focusEvents.length, "Events this week")}
        ${kpiCard(focusEvents.filter((event) => event.afterHours).length, "After-hours events")}
        ${staff ? kpiCard(visibleGaps.length, "Coverage gaps") : kpiCard(visibleRequests.filter((request) => request.status === "pending").length, "Requests for me")}
      </div>
    </section>

    ${staff ? "" : studentHoursSummaryPanel(currentWorker())}

    <section class="panel">
      ${staff ? calendarStaffFilters() : calendarStudentSummary(visibleSpaces)}
    </section>

    <section class="panel flush">
      <div class="table-wrap">
        <div class="space-calendar-grid">
          ${DAYS.map((day, index) => calendarDayCard(day, addDays(app.data.focusWeekStart, index), visibleSpaceSet, workerFilter)).join("")}
        </div>
      </div>
    </section>
  `;
}

function calendarStaffFilters() {
  return `
    <div class="calendar-toolbar">
      <label class="stacked-field">Space
        <select data-calendar-filter="space">
          <option value="">All spaces</option>
          ${app.data.spaces.map((space) => `<option value="${escapeHtml(space.name)}" ${app.spaceCalendar.space === space.name ? "selected" : ""}>${escapeHtml(space.name)}</option>`).join("")}
        </select>
      </label>
      <label class="stacked-field">Student
        <select data-calendar-filter="workerId">
          <option value="">All students</option>
          ${app.data.workers.map((worker) => `<option value="${worker.id}" ${app.spaceCalendar.workerId === worker.id ? "selected" : ""}>${escapeHtml(worker.name)}</option>`).join("")}
        </select>
      </label>
      <div class="calendar-note">
        <strong>What this shows</strong>
        <span>Student schedules, staff coverage, bookings, after-hours needs, and coverage requests for the selected week.</span>
      </div>
      ${calendarExportActions(false)}
    </div>
  `;
}

function calendarStudentSummary(visibleSpaces) {
  return `
    <div class="calendar-toolbar student-calendar-note">
      <div class="calendar-note">
        <strong>What this shows</strong>
        <span>Your shifts and the event activity happening in your assigned space${visibleSpaces.length === 1 ? "" : "s"} for this week.</span>
      </div>
      ${calendarExportActions(true)}
    </div>
  `;
}

function calendarExportActions(includeScheduleEdit) {
  return `
    <div class="calendar-export-actions">
      ${includeScheduleEdit ? `<button class="secondary-button" type="button" data-action="open-profile">Edit My Schedule</button>` : ""}
      <button class="ghost-button" type="button" data-action="export-space-calendar-pdf">Export PDF</button>
      <button class="ghost-button" type="button" data-action="export-space-calendar-xlsx">Export Excel</button>
    </div>
  `;
}

function calendarDayCard(day, date, visibleSpaceSet, workerFilter) {
  const shifts = calendarShiftItems(day, date, visibleSpaceSet, workerFilter);
  const events = eventsInFocusWeek(app.data.events || []).filter((event) => event.date === date && visibleSpaceSet.has(event.space));
  const gapCount = app.data.role === "staff" ? (app.data.coverageGaps || []).filter((gap) => gap.date === date && visibleSpaceSet.has(gap.space)).length : 0;
  return `
    <article class="calendar-day">
      <header class="calendar-day-head">
        <div>
          <strong>${escapeHtml(day)}</strong>
          <span>${formatShortDate(date)}</span>
        </div>
        ${gapCount ? `<span class="badge warning-badge">${gapCount} gap${gapCount === 1 ? "" : "s"}</span>` : ""}
      </header>
      <div class="calendar-section">
        <h4>Schedule</h4>
        ${shifts.length ? shifts.map(calendarShiftCard).join("") : `<p class="task-meta">No scheduled coverage.</p>`}
      </div>
      <div class="calendar-section">
        <h4>Events</h4>
        ${events.length ? events.map(calendarEventCard).join("") : `<p class="task-meta">No events in these spaces.</p>`}
      </div>
    </article>
  `;
}

function calendarVisibleSpaces(spaceFilter, workerFilter) {
  if (app.data.role === "staff" && spaceFilter) return [spaceFilter];
  const worker = workerFilter ? workerById(workerFilter) : null;
  if (worker) {
    const spaces = new Set(worker.primarySpaces || []);
    availabilityInFocusWeek(worker).forEach(({ slot }) => spaces.add(slot.space));
    return [...spaces].filter(Boolean);
  }
  if (app.data.role === "student") {
    const student = currentWorker();
    if (!student) return [];
    const spaces = new Set(student.primarySpaces || []);
    availabilityInFocusWeek(student).forEach(({ slot }) => spaces.add(slot.space));
    return [...spaces].filter(Boolean);
  }
  return app.data.spaces.map((space) => space.name).filter((space) => space !== "General");
}

function calendarShiftItems(day, date, visibleSpaceSet, workerFilter) {
  const staffView = app.data.role === "staff";
  const workers = staffView
    ? (workerFilter ? [workerById(workerFilter)].filter(Boolean) : app.data.workers)
    : [currentWorker()].filter(Boolean);
  const studentShifts = workers.flatMap((worker) =>
    (worker.availability || [])
      .filter((slot) => visibleSpaceSet.has(slot.space) && scheduleItemMatchesDate(slot, day, date))
      .map((slot) => ({
        type: staffView ? "student" : "my",
        name: worker.name,
        space: slot.space,
        start: slot.start,
        end: slot.end
      }))
  );
  const staffShifts = staffView
    ? (app.data.staffSchedules || [])
      .filter(calendarStaffScheduleVisible)
      .filter((slot) => visibleSpaceSet.has(slot.space) && scheduleItemMatchesDate(slot, day, date))
      .map((slot) => ({
        type: "staff",
        name: slot.name,
        space: slot.space,
        start: slot.start,
        end: slot.end
      }))
    : [];
  return dedupeCalendarShifts([...studentShifts, ...staffShifts])
    .sort((a, b) => minutes(a.start) - minutes(b.start) || a.space.localeCompare(b.space) || a.name.localeCompare(b.name));
}

function calendarStaffScheduleVisible(slot) {
  return !removedStaffScheduleName(slot.name) && !copiedStudentCoverageSchedule(slot);
}

function removedStaffScheduleName(name) {
  return ["lynn", "lynn romero"].includes(normalizeScheduleName(name));
}

function copiedStudentCoverageSchedule(slot) {
  const note = String(slot.notes || "").trim().toLowerCase();
  return ["space coverage", "summer student coverage", "operations aide coverage"].includes(note) || String(slot.id || "").startsWith("coverage-");
}

function dedupeCalendarShifts(shifts) {
  const merged = new Map();
  shifts.forEach((shift) => {
    const key = [
      normalizeScheduleName(shift.name),
      normalizeScheduleSpace(shift.space),
      shift.start,
      shift.end
    ].join("|");
    const existing = merged.get(key);
    if (!existing || existing.type === "staff") {
      merged.set(key, shift);
    }
  });
  return [...merged.values()];
}

function calendarShiftCard(shift) {
  const label = shift.type === "staff" ? "Staff" : shift.type === "my" ? "My shift" : "Student";
  return `
    <article class="calendar-item shift-item" style="border-left-color:${app.data.spaceColors[shift.space] || app.data.spaceColors.General}">
      <strong>${escapeHtml(shift.name)}</strong>
      <span>${spaceChip(shift.space)} ${formatTime(shift.start)}-${formatTime(shift.end)}</span>
      <em>${escapeHtml(label)}</em>
    </article>
  `;
}

function calendarEventCard(event) {
  const requests = (app.data.coverageRequests || []).filter((request) => request.eventId === event.id);
  const studentRequest = requests.find((request) => request.workerId === app.data.currentUser.workerId);
  const coverageText = calendarEventCoverageText(event);
  return `
    <article class="calendar-item event-item" style="border-left-color:${app.data.spaceColors[event.space] || app.data.spaceColors.General}">
      <div class="calendar-item-head">
        <strong>${escapeHtml(event.title)}</strong>
        ${event.afterHours ? `<span class="badge warning-badge">After hours</span>` : ""}
      </div>
      <span>${spaceChip(event.space)} ${eventRoomBadge(event)} ${formatTime(event.start)}-${formatTime(event.end)}</span>
      <em>${escapeHtml(coverageText)}</em>
      ${staffEventCoverageActions(event)}
      ${studentRequest ? calendarStudentRequestActions(studentRequest, event) : ""}
    </article>
  `;
}

function calendarEventCoverageText(event) {
  const requests = (app.data.coverageRequests || []).filter((request) => request.eventId === event.id);
  const studentRequest = requests.find((request) => request.workerId === app.data.currentUser.workerId);
  const assigned = workerById(event.assignedTo)?.name;
  const blockSummary = coverageBlockSummary(event);
  if (event.status === "covered") return "Coverage cleared by staff.";
  if (event.status === "rejected") return "Coverage request dismissed by staff.";
  if (app.data.role === "student") return studentEventSummary(event, studentRequest);
  if (blockSummary) return blockSummary;
  if (assigned) return `Assigned to ${assigned}`;
  const activeRequests = requests.filter((request) => !["closed", "denied", "dismissed", "covered"].includes(request.status));
  if (activeRequests.length) return `Request sent to ${activeRequests.map((request) => workerById(request.workerId)?.name || "student").join(", ")}`;
  return event.afterHours ? "Needs supervisor review" : "Inside business hours";
}

function studentEventSummary(event, request) {
  if (event.status === "covered") return "Coverage cleared by staff.";
  if (event.status === "rejected") return "Coverage request dismissed by staff.";
  if (request) return `Coverage request: ${studentRequestHint(request)}`;
  if (event.afterHours) return "After-hours event in your space.";
  return "Event happening during business hours.";
}

function staffEventCoverageActions(event) {
  if (app.data.role !== "staff" || !event.afterHours || afterHoursCoverageResolved(event)) return "";
  if (acceptedCoverageExists(event)) return coverageBlockList(event);
  return `
    <div class="calendar-actions">
      <button class="secondary-button" type="button" data-action="event-coverage-action" data-event-id="${event.id}" data-event-action="covered">Clear as Covered</button>
      <button class="danger-button" type="button" data-action="event-coverage-action" data-event-id="${event.id}" data-event-action="reject">Reject</button>
    </div>
    ${coverageBlockList(event)}
    ${coverageBlockForm(event)}
  `;
}

function acceptedCoverageExists(event) {
  return event.status === "accepted" ||
    event.status === "scheduled" ||
    (app.data.coverageRequests || []).some((request) =>
      request.eventId === event.id && ["accepted", "scheduled"].includes(request.status)
    );
}

function coverageBlockSummary(event) {
  const blocks = event.coverageBlocks || [];
  if (!blocks.length) return "";
  const done = blocks.filter((block) => ["accepted", "covered", "scheduled", "rejected"].includes(block.status)).length;
  const pending = blocks.length - done;
  return `${done}/${blocks.length} coverage block${blocks.length === 1 ? "" : "s"} handled${pending ? `, ${pending} still open` : ""}.`;
}

function coverageBlockList(event) {
  const blocks = event.coverageBlocks || [];
  if (!blocks.length) return "";
  return `
    <div class="coverage-block-list">
      ${blocks.map((block) => {
        const worker = workerById(block.workerId)?.name || block.resolvedBy || "";
        return `<div class="coverage-block-row">
          <span>${formatTime(block.start)}-${formatTime(block.end)}</span>
          <strong>${escapeHtml(blockStatusLabel(block.status))}</strong>
          ${worker ? `<em>${escapeHtml(worker)}</em>` : ""}
        </div>`;
      }).join("")}
    </div>
  `;
}

function coverageBlockForm(event) {
  return `
    <form class="coverage-block-form" data-coverage-block-form data-event-id="${event.id}">
      <label>Start<input name="start" type="time" value="${event.start}" required></label>
      <label>End<input name="end" type="time" value="${event.end}" required></label>
      <label>Action
        <select name="mode">
          <option value="request">Request student</option>
          <option value="covered">Mark covered</option>
        </select>
      </label>
      <label>Student${workerSelectWithBlank("", "Choose student")}</label>
      <button class="secondary-button" type="submit">Add Block</button>
    </form>
  `;
}

function blockStatusLabel(status) {
  return {
    requesting: "Requesting",
    pending: "Pending",
    accepted: "Accepted",
    scheduled: "Scheduled",
    covered: "Covered",
    rejected: "Rejected",
    "needs-review": "Needs review"
  }[status] || status || "Open";
}

function calendarStudentRequestActions(request, event) {
  const worker = currentWorker();
  const projected = worker ? projectedHoursForRequest(worker, event, request) : null;
  const overLimit = Boolean(projected && request.status === "accepted" && projected.projected > projected.limit);
  return `
    <div class="calendar-actions">
      ${request.status === "pending" ? requestButton(request, "accept", "Accept", "primary-button") + requestButton(request, "deny", "Deny", "danger-button") : ""}
      ${request.status === "accepted" && !overLimit ? requestButton(request, "add-to-schedule", "Add to My Schedule", "secondary-button") : ""}
      ${request.status === "accepted" && overLimit ? `<button class="secondary-button" type="button" data-action="open-profile">Edit My Schedule</button>` : ""}
      ${projected ? `<span class="task-meta ${projected.projected > projected.limit ? "limit-warning" : ""}">${escapeHtml(hourSummaryText(projected, request.status))}</span>` : ""}
    </div>
  `;
}

function spaceCalendarDayData(context, day, date) {
  return {
    shifts: calendarShiftItems(day, date, context.visibleSpaceSet, context.workerFilter),
    events: eventsInFocusWeek(app.data.events || []).filter((event) => event.date === date && context.visibleSpaceSet.has(event.space))
  };
}

function calendarShiftRoleLabel(type) {
  if (type === "staff") return "Staff";
  if (type === "my") return "My shift";
  return "Student";
}

function spaceCalendarExportRows(context) {
  return DAYS.flatMap((day, index) => {
    const date = addDays(context.weekStart, index);
    const { shifts, events } = spaceCalendarDayData(context, day, date);
    const shiftRows = shifts.map((shift) => [
      date,
      day,
      "Schedule",
      shift.space,
      "",
      shift.name,
      calendarShiftRoleLabel(shift.type),
      formatTime(shift.start),
      formatTime(shift.end),
      "",
      ""
    ]);
    const eventRows = events.map((event) => [
      event.date,
      day,
      "Event",
      event.space,
      eventRoomExportLabel(event),
      event.title,
      "",
      formatTime(event.start),
      formatTime(event.end),
      event.afterHours ? "After hours" : "Business hours",
      calendarEventCoverageText(event)
    ]);
    return [...shiftRows, ...eventRows];
  });
}

function exportSpaceCalendarXlsx() {
  const context = currentSpaceCalendarContext();
  const rows = [
    ["Edson E+I Space Calendar"],
    ["View", context.title],
    ["Week", `${formatShortDate(context.weekStart)} - ${formatShortDate(context.weekEnd)}`],
    ["Spaces", context.visibleSpaces.join(", ") || "No spaces"],
    ["Student filter", context.workerName || (context.staff ? "All students" : app.data.currentUser.name)],
    [],
    ["Date", "Day", "Type", "Space", "Room", "Person / Event", "Role", "Start", "End", "Status", "Notes"],
    ...spaceCalendarExportRows(context)
  ];
  const bytes = buildXlsx([{ name: "Space Calendar", rows }]);
  downloadBlob(
    new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${spaceCalendarFilename(context)}.xlsx`
  );
  showToast("Excel export downloaded.");
}

function exportSpaceCalendarPdf() {
  const context = currentSpaceCalendarContext();
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("Allow pop-ups to export the PDF.");
    return;
  }
  printWindow.document.open();
  printWindow.document.write(spaceCalendarPrintHtml(context));
  printWindow.document.close();
  const printCalendar = () => {
    printWindow.focus();
    printWindow.print();
  };
  if (printWindow.document.readyState === "complete") {
    setTimeout(printCalendar, 150);
  } else {
    printWindow.addEventListener("load", () => setTimeout(printCalendar, 150), { once: true });
  }
  showToast("PDF export opened. Choose Save as PDF.");
}

function spaceCalendarPrintHtml(context) {
  const dayHeadings = DAYS.map((day, index) => `
    <div class="snapshot-head">
      <strong>${escapeHtml(day.slice(0, 3))}</strong>
      <span>${escapeHtml(formatShortDate(addDays(context.weekStart, index)))}</span>
    </div>
  `).join("");
  const rows = context.visibleSpaces.map((space) => `
    <div class="snapshot-space">${spaceChip(space)}</div>
    ${DAYS.map((day, index) => spaceCalendarSnapshotCell(context, space, day, addDays(context.weekStart, index))).join("")}
  `).join("");

  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(context.title)} Export</title>
        <style>
          * { box-sizing: border-box; }
          body { color: #191919; font-family: Arial, sans-serif; margin: 0; }
          header { align-items: flex-end; border-bottom: 3px solid #8c1d40; display: flex; justify-content: space-between; margin-bottom: 10px; padding-bottom: 8px; }
          h1 { font-size: 19px; margin: 0; }
          .meta { color: #667085; font-size: 10px; margin-top: 3px; }
          .legend { color: #344054; font-size: 9px; text-align: right; }
          .snapshot-grid { display: grid; grid-template-columns: 88px repeat(7, minmax(0, 1fr)); width: 100%; }
          .snapshot-corner,
          .snapshot-head,
          .snapshot-space,
          .snapshot-cell { border: 1px solid #d8dee8; margin: -1px 0 0 -1px; }
          .snapshot-corner,
          .snapshot-head { background: #f4f6f9; min-height: 32px; padding: 5px; }
          .snapshot-head strong,
          .snapshot-head span { display: block; }
          .snapshot-head strong { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
          .snapshot-head span { color: #667085; font-size: 9px; margin-top: 2px; }
          .snapshot-space { align-items: flex-start; background: #fbfcfe; display: flex; min-height: 82px; padding: 5px; }
          .snapshot-cell { min-height: 82px; padding: 4px; }
          .space-chip { align-items: center; background: #fff; border: 1px solid currentColor; border-radius: 999px; display: inline-flex; font-size: 8px; font-weight: 800; line-height: 1; padding: 3px 5px; white-space: nowrap; }
          .cell-empty { color: #98a2b3; font-size: 8px; }
          .cell-item { border-left: 3px solid #8c1d40; margin-bottom: 3px; padding-left: 4px; }
          .cell-item.event { border-left-color: #ffc627; }
          .cell-item strong { display: block; font-size: 8.5px; line-height: 1.15; }
          .cell-item span { color: #344054; display: block; font-size: 8px; line-height: 1.2; }
          .cell-item em { color: #667085; display: block; font-size: 7.5px; font-style: normal; line-height: 1.15; }
          .cell-more { color: #667085; font-size: 7.5px; font-weight: 700; }
          @page { size: letter landscape; margin: 0.25in; }
          @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>
        <header>
          <div>
            <h1>${escapeHtml(context.title)}</h1>
            <div class="meta">Week of ${escapeHtml(formatShortDate(context.weekStart))} - ${escapeHtml(formatShortDate(context.weekEnd))}</div>
            <div class="meta">Spaces: ${escapeHtml(context.visibleSpaces.join(", ") || "No spaces")}</div>
          </div>
          <div class="legend">Student filter: ${escapeHtml(context.workerName || (context.staff ? "All students" : app.data.currentUser.name))}</div>
        </header>
        <main class="snapshot-grid">
          <div class="snapshot-corner"></div>
          ${dayHeadings}
          ${rows || `<div class="snapshot-space">No spaces</div>`}
        </main>
      </body>
    </html>`;
}

function spaceCalendarSnapshotCell(context, space, day, date) {
  const { shifts, events } = spaceCalendarDayData(context, day, date);
  const items = [
    ...shifts
      .filter((shift) => shift.space === space)
      .map((shift) => ({
        type: "shift",
        title: shift.name,
        meta: `${formatTime(shift.start)}-${formatTime(shift.end)}`,
        detail: calendarShiftRoleLabel(shift.type)
      })),
    ...events
      .filter((event) => event.space === space)
      .map((event) => ({
        type: "event",
        title: event.title,
        meta: `${eventRoomLabel(event) ? `${eventRoomLabel(event)} | ` : ""}${formatTime(event.start)}-${formatTime(event.end)}${event.afterHours ? " | After hours" : ""}`,
        detail: calendarEventCoverageText(event)
      }))
  ];
  const visibleItems = items.slice(0, 4);
  return `
    <div class="snapshot-cell">
      ${visibleItems.length ? visibleItems.map((item) => `
        <div class="cell-item ${item.type === "event" ? "event" : ""}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.meta)}</span>
          <em>${escapeHtml(item.detail)}</em>
        </div>
      `).join("") : `<span class="cell-empty">No coverage</span>`}
      ${items.length > visibleItems.length ? `<div class="cell-more">+${items.length - visibleItems.length} more</div>` : ""}
    </div>
  `;
}

function spaceCalendarFilename(context) {
  const filter = context.workerName || context.spaceFilter || (context.staff ? "all" : app.data.currentUser.name);
  return `edson-ei-space-calendar-${context.weekStart}-${slugify(filter)}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugify(value) {
  return String(value || "calendar")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "calendar";
}

function buildXlsx(sheets) {
  const files = [
    { name: "[Content_Types].xml", data: contentTypesXml(sheets) },
    { name: "_rels/.rels", data: rootRelsXml() },
    { name: "xl/workbook.xml", data: workbookXml(sheets) },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelsXml(sheets) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: worksheetXml(sheet.rows)
    }))
  ];
  return zipFiles(files);
}

function contentTypesXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
    </Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`;
}

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>
        ${sheets.map((sheet, index) => `<sheet name="${xmlEscape(xlsxSheetName(sheet.name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}
      </sheets>
    </workbook>`;
}

function workbookRelsXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
    </Relationships>`;
}

function worksheetXml(rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        ${rows.map((row, rowIndex) => `
          <row r="${rowIndex + 1}">
            ${(row || []).map((cell, columnIndex) => `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`).join("")}
          </row>
        `).join("")}
      </sheetData>
    </worksheet>`;
}

function xlsxSheetName(name) {
  return String(name || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
}

function columnName(index) {
  let name = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function zipFiles(files) {
  const encoder = new TextEncoder();
  const prepared = files.map((file) => ({
    nameBytes: encoder.encode(file.name),
    dataBytes: encoder.encode(file.data)
  }));
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  prepared.forEach((file) => {
    const crc = crc32(file.dataBytes);
    const localHeader = new Uint8Array(30 + file.nameBytes.length);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, file.dataBytes.length, true);
    local.setUint32(22, file.dataBytes.length, true);
    local.setUint16(26, file.nameBytes.length, true);
    localHeader.set(file.nameBytes, 30);
    localParts.push(localHeader, file.dataBytes);

    const centralHeader = new Uint8Array(46 + file.nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, file.dataBytes.length, true);
    central.setUint32(24, file.dataBytes.length, true);
    central.setUint16(28, file.nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralHeader.set(file.nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + file.dataBytes.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

let crcTableCache;

function crc32(bytes) {
  const table = crcTableCache || (crcTableCache = createCrcTable());
  let crc = -1;
  bytes.forEach((byte) => {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  });
  return (crc ^ -1) >>> 0;
}

function createCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let current = index;
    for (let bit = 0; bit < 8; bit += 1) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    return current >>> 0;
  });
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderSchedules() {
  const staff = app.data.role === "staff";
  const totalBlocks = app.data.workers.reduce((sum, worker) => sum + availabilityInFocusWeek(worker).length, 0);
  const focusRequests = requestsInFocusWeek(app.data.coverageRequests || []);
  const pendingRequests = focusRequests.filter((request) => request.status === "pending").length;
  const focusEvents = eventsInFocusWeek(app.data.events || []);
  const afterHoursNeeds = focusEvents.filter((event) => event.afterHours && !afterHoursCoverageResolved(event)).length;
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Automated Coverage Check</p>
          <h3>This Week</h3>
        </div>
      </div>
      <div class="kpi-grid">
        ${kpiCard(app.data.coverageGaps.length, "Needs attention")}
        ${kpiCard(pendingRequests, "Student requests")}
        ${kpiCard(focusEvents.length, "Bookings this week")}
        ${kpiCard(afterHoursNeeds, "After-hours needs")}
        ${kpiCard(totalBlocks, "Student shifts")}
      </div>
    </section>
    ${staff ? `
    <section class="split-grid">
      <div class="panel">
        <h3>Needs Attention</h3>
        ${renderAttentionList()}
      </div>
      <div class="panel">
        <h3>Add Event</h3>
        ${smartEventForm()}
      </div>
    </section>
    ` : `
    <section class="panel">
      <h3>Coverage Status</h3>
      ${app.data.coverageGaps.length ? `<div class="alert-stack">${app.data.coverageGaps.slice(0, 6).map((gap) => alertCard(gapToAlert(gap))).join("")}</div>` : emptyState("All spaces are covered for configured business hours.")}
    </section>
    `}
    <section class="panel flush">
      <div class="table-wrap">${scheduleGrid()}</div>
    </section>
    <section class="split-grid">
      <div class="panel">
        <h3>Staff / Space Coverage</h3>
        ${staffScheduleTable()}
      </div>
      ${staff ? `<div class="panel"><h3>Quick Schedule Edit</h3>${scheduleForm(app.editingSchedule?.workerId || app.data.workers[0]?.id, true)}</div>` : `<div class="panel"><h3>My Requests</h3>${renderRequestList(focusRequests)}</div>`}
    </section>
  `;
}

function renderEvents() {
  const focusEvents = eventsInFocusWeek(app.data.events || []);
  const afterHours = focusEvents.filter((event) => event.afterHours);
  const handled = focusEvents.filter((event) => !event.afterHours || afterHoursCoverageResolved(event)).length;
  const focusRequests = requestsInFocusWeek(app.data.coverageRequests || []);
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Mazevo Bookings</p>
          <h3>${formatShortDate(app.data.focusWeekStart)}-${formatShortDate(addDays(app.data.focusWeekStart, 6))}</h3>
        </div>
        <div class="action-row">
          <button class="secondary-button" type="button" data-action="sync-mazevo">Sync From Mazevo</button>
        </div>
      </div>
      <div class="kpi-grid">
        ${kpiCard(focusEvents.length, "Bookings this week")}
        ${kpiCard(afterHours.length, "After-hours events")}
        ${kpiCard(focusRequests.filter((request) => request.status === "pending").length, "Student requests")}
        ${kpiCard(handled, "Already covered")}
      </div>
    </section>
    <section class="split-grid">
      <div class="panel">
        <h3>Mazevo Source</h3>
        ${mazevoSyncPanel()}
      </div>
      <div class="panel">
        <h3>Student Requests</h3>
        ${renderRequestList(focusRequests)}
      </div>
    </section>
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">After-Hours + Event Coverage</p>
          <h3>Bookings This Week</h3>
        </div>
      </div>
      <div class="task-list">${focusEvents.map(eventCard).join("") || emptyState("No bookings this week.")}</div>
    </section>
  `;
}

function renderRequests() {
  const requests = requestsInFocusWeek(app.data.coverageRequests || []);
  const pending = requests.filter((request) => request.status === "pending").length;
  const accepted = requests.filter((request) => request.status === "accepted").length;
  const scheduled = requests.filter((request) => request.status === "scheduled").length;
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Student Coverage Requests</p>
          <h3>Extra Coverage I Can Respond To</h3>
        </div>
      </div>
      <div class="kpi-grid">
        ${kpiCard(pending, "Need response")}
        ${kpiCard(accepted, "Accepted")}
        ${kpiCard(scheduled, "Added to schedule")}
        ${kpiCard(requests.filter((request) => request.status === "denied").length, "Denied")}
      </div>
    </section>
    <section class="panel">
      ${renderRequestList(requests)}
    </section>
  `;
}

function renderSpaces() {
  return `
    <section class="panel flush">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Space</th><th>Campus</th><th>Business Hours</th></tr></thead>
          <tbody>${app.data.spaces.map(spaceHoursRow).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function mazevoSyncPanel() {
  const mazevo = app.data.integrations?.mazevo || {};
  const summary = mazevo.lastSyncSummary;
  const configured = mazevo.configured;
  const statusText = configured
    ? `Ready${mazevo.lastSyncAt ? `; last sync ${formatDateTime(mazevo.lastSyncAt)}` : "; not synced yet"}.`
    : `Not configured${mazevo.missing?.length ? `: ${mazevo.missing.join(", ")}` : ""}.`;
  const summaryText = summary
    ? `${summary.imported || 0} imported, ${summary.updated || 0} updated, ${(summary.legacyBookingsRemoved || 0) + (summary.duplicatesRemoved || 0) + (summary.staleMazevoEventsRemoved || 0)} old rows cleared, ${summary.skippedUnconfirmed || 0} skipped as not confirmed.`
    : "Confirmed Mazevo events will appear here after sync. Old spreadsheet booking imports are hidden.";
  return `
    <div class="integration-note ${configured ? "" : "warning-note"}">
      <strong>Mazevo sync</strong>
      <span>${escapeHtml(statusText)}</span>
      <span>${escapeHtml(summaryText)}</span>
      ${mazevo.lastSyncError ? `<span class="limit-warning">${escapeHtml(mazevo.lastSyncError)}</span>` : ""}
    </div>
  `;
}

function smartEventForm() {
  return `
    <form id="smartEventForm" class="form-grid">
      <label class="span-3">Event Name<input name="title" required maxlength="160" placeholder="Pitch In evening check-in"></label>
      <label>Event Date<input name="date" type="date" value="${app.data.focusDate}" required></label>
      <label>Space${spaceSelect("space")}</label>
      <label>Start<input name="start" type="time" value="17:30" required></label>
      <label>End<input name="end" type="time" value="19:30" required></label>
      <label class="span-6">Notes<textarea name="notes" placeholder="What does the student need to cover?"></textarea></label>
      <div class="span-6 action-row"><button class="primary-button" type="submit">Add Event</button></div>
    </form>
  `;
}

function staffScheduleForm() {
  return `
    <form id="staffScheduleForm" class="form-grid">
      <label class="span-2">Staff Name<input name="name" required placeholder="Supervisor name"></label>
      <label>Day${daySelect()}</label>
      <label>Space${spaceSelect("space")}</label>
      <label>Start<input name="start" type="time" value="09:00" required></label>
      <label>End<input name="end" type="time" value="17:00" required></label>
      <label class="span-6">Notes<input name="notes" placeholder="On-site, remote, event support"></label>
      <div class="span-6 action-row"><button class="primary-button" type="submit">Add Staff Schedule</button></div>
    </form>
  `;
}

function renderRequestList(requests) {
  const sorted = [...requests].sort((a, b) => requestSortValue(a) - requestSortValue(b));
  return sorted.length ? `<div class="task-list">${sorted.map(coverageRequestCard).join("")}</div>` : emptyState("No coverage requests yet.");
}

function renderAttentionList() {
  const eventAlerts = (app.data.alerts || [])
    .filter((alert) => !alert.title.includes("uncovered time") && !alert.title.startsWith("Gap:"))
    .slice(0, 4)
    .map(alertCard);
  const gapAlerts = (app.data.coverageSuggestions || []).slice(0, 6).map(coverageGapCard);
  const cards = [...eventAlerts, ...gapAlerts];
  return cards.length ? `<div class="alert-stack">${cards.join("")}</div>` : emptyState("Nothing needs attention. All spaces are covered during business hours.");
}

function requestSortValue(request) {
  const event = eventById(request.eventId);
  const statusRank = { pending: 0, accepted: 1, scheduled: 2, denied: 3, dismissed: 4, covered: 5, closed: 6 };
  return (statusRank[request.status] ?? 9) * 100000000 + new Date(`${event?.date || "2099-12-31"}T12:00:00`).getTime();
}

function coverageRequestCard(request) {
  const event = eventById(request.eventId);
  const worker = workerById(request.workerId);
  const staff = app.data.role === "staff";
  const canAct = !staff && request.workerId === app.data.currentUser.workerId;
  const projected = worker && event ? projectedHoursForRequest(worker, event, request) : null;
  const overLimit = Boolean(projected && request.status === "accepted" && projected.projected > projected.limit);
  if (!event) return "";
  return `
    <article class="task-card">
      <div class="task-head">
        <h4>${escapeHtml(event.title)}</h4>
        ${statusPill(request.status)}
      </div>
      <div class="badge-row">
        ${spaceChip(event.space)}
        ${eventRoomBadge(event)}
        <span class="badge">${formatShortDate(event.date)}</span>
        <span class="badge">${requestTimeLabel(request, event)}</span>
        ${event.afterHours ? `<span class="badge warning-badge">After hours</span>` : ""}
        ${staff ? `<span class="badge">${escapeHtml(worker?.name || "Unknown student")}</span>` : ""}
      </div>
      <p class="task-meta">${escapeHtml(request.reason || "Matched by space, schedule, and coverage skill.")}</p>
      ${projected ? `<p class="task-meta ${projected.projected > projected.limit ? "limit-warning" : ""}">${escapeHtml(hourSummaryText(projected, request.status))}</p>` : ""}
      <div class="task-footer">
        <span class="task-meta">${staff ? `Student response: ${request.status}` : studentRequestHint(request)}</span>
        <div class="action-row">
          ${canAct && request.status === "pending" ? requestButton(request, "accept", "Accept", "primary-button") + requestButton(request, "deny", "Deny", "danger-button") : ""}
          ${canAct && request.status === "accepted" && !overLimit ? requestButton(request, "add-to-schedule", "Add to My Schedule", "secondary-button") : ""}
          ${canAct && request.status === "accepted" && overLimit ? `<button class="secondary-button" type="button" data-action="open-profile">Edit My Schedule</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function eventCard(event) {
  const coverageText = event.afterHours
    ? calendarEventCoverageText(event)
    : "Inside business hours. No extra student request needed.";
  return `
    <article class="task-card">
      <div class="task-head">
        <h4>${escapeHtml(event.title)}</h4>
        ${statusPill(event.status)}
      </div>
      <div class="badge-row">
        ${spaceChip(event.space)}
        ${eventRoomBadge(event)}
        <span class="badge">${formatShortDate(event.date)}</span>
        <span class="badge">${formatTime(event.start)}-${formatTime(event.end)}</span>
        ${event.source === "mazevo" ? `<span class="badge">Mazevo</span>` : ""}
        ${event.afterHours ? `<span class="badge warning-badge">After hours</span>` : ""}
      </div>
      <p class="task-meta">${escapeHtml(event.notes || "No notes added.")}</p>
      <p class="task-meta">${escapeHtml(coverageText)}</p>
      ${staffEventCoverageActions(event)}
    </article>
  `;
}

function coverageGapCard(gap) {
  const candidate = gap.candidates?.[0];
  return `
    <article class="alert-card warning">
      <strong>Gap: ${escapeHtml(gap.space)}</strong>
      <span>No coverage on ${formatShortDate(gap.date)} from ${escapeHtml(gap.detail)}.</span>
      ${candidate ? `<div class="candidate-list">
        <div class="candidate-row">
          <strong>Suggested: ${escapeHtml(candidate.name)}</strong>
          <span>${escapeHtml(candidate.reason)}</span>
        </div>
      </div>` : `<span>No obvious student match. Supervisor review needed.</span>`}
    </article>
  `;
}

function staffScheduleTable() {
  const schedules = (app.data.staffSchedules || [])
    .filter(calendarStaffScheduleVisible)
    .filter(scheduleItemInFocusWeek)
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || minutes(a.start) - minutes(b.start) || a.space.localeCompare(b.space));
  if (!schedules.length) return emptyState("No staff schedules added yet.");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Staff</th><th>Day</th><th>Space</th><th>Time</th><th>Notes</th></tr></thead>
        <tbody>${schedules.map((item) => `
          <tr>
            <td><strong>${escapeHtml(item.name)}</strong></td>
            <td>${escapeHtml(item.day)}</td>
            <td>${spaceChip(item.space)}</td>
            <td>${formatTime(item.start)}-${formatTime(item.end)}</td>
            <td>${escapeHtml(item.notes || "")}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      app.view = button.dataset.view;
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action, button));
  });

  document.querySelectorAll("[data-calendar-filter]").forEach((select) => {
    select.addEventListener("change", () => {
      app.spaceCalendar[select.dataset.calendarFilter] = select.value;
      render();
    });
  });

  bindForm("taskForm", createTask);
  bindForm("eventForm", createEvents);
  bindForm("smartEventForm", createSmartEvent);
  bindForm("staffScheduleForm", createStaffSchedule);
  bindForm("workerForm", createWorker);
  bindForm("userForm", createUser);
  bindForm("skillForm", saveSkills);
  bindForm("scheduleForm", saveSchedule);
  document.querySelectorAll("[data-coverage-block-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await createCoverageBlock(event.currentTarget);
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

function bindForm(id, handler) {
  const form = document.getElementById(id);
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await handler(event.currentTarget);
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function handleAction(action, button) {
  try {
    if (action === "logout") {
      await api("/api/logout", { method: "POST" });
      renderLogin();
      return;
    }
    if (action === "open-task-form") {
      app.view = "tasks";
      render();
      return;
    }
    if (action === "rerun-ai") {
      app.data = await api("/api/assign", { method: "POST" });
      showToast("Open tasks reassigned.");
      render();
      return;
    }
    if (action === "generate-worldlabs") {
      app.data = await api("/api/generate-worldlabs", { method: "POST", body: { focusDate: app.data.focusDate } });
      showToast("WorldLabs tasks generated.");
      render();
      return;
    }
    if (action === "sync-mazevo") {
      app.data = await api("/api/mazevo/sync", {
        method: "POST",
        body: {
          from: app.data.focusWeekStart,
          to: addDays(app.data.focusWeekStart, 60)
        }
      });
      showToast("Mazevo confirmed events synced.");
      render();
      return;
    }
    if (action === "open-profile") {
      app.view = "profile";
      render();
      return;
    }
    if (action === "export-space-calendar-pdf") {
      exportSpaceCalendarPdf();
      return;
    }
    if (action === "export-space-calendar-xlsx") {
      exportSpaceCalendarXlsx();
      return;
    }
    if (action === "clear-schedule-edit") {
      app.editingSchedule = null;
      render();
      return;
    }
    if (action === "edit-schedule") {
      app.editingSchedule = {
        workerId: button.dataset.workerId,
        slotIndex: Number(button.dataset.slotIndex)
      };
      if (app.data.role === "student") app.view = "profile";
      render();
      return;
    }
    if (action === "task-action") {
      const taskId = button.dataset.taskId;
      const taskAction = button.dataset.taskAction;
      app.data = await api(`/api/tasks/${encodeURIComponent(taskId)}/action`, { method: "POST", body: { action: taskAction } });
      showToast("Task updated.");
      render();
      return;
    }
    if (action === "coverage-request") {
      const requestId = button.dataset.requestId;
      const requestAction = button.dataset.requestAction;
      app.data = await api(`/api/coverage-requests/${encodeURIComponent(requestId)}/action`, { method: "POST", body: { action: requestAction } });
      showToast(requestAction === "add-to-schedule" ? "Added to your schedule. Supervisor alerted." : "Coverage request updated.");
      render();
      return;
    }
    if (action === "event-coverage-action") {
      const eventId = button.dataset.eventId;
      const eventAction = button.dataset.eventAction;
      app.data = await api(`/api/events/${encodeURIComponent(eventId)}/coverage-action`, { method: "POST", body: { action: eventAction } });
      showToast(eventAction === "covered" ? "Event cleared as covered." : "Coverage request dismissed.");
      render();
      return;
    }
    if (action === "remove-schedule") {
      const workerId = button.dataset.workerId;
      const index = button.dataset.slotIndex;
      app.data = await api(`/api/workers/${encodeURIComponent(workerId)}/schedules/${index}`, { method: "DELETE" });
      app.editingSchedule = null;
      showToast("Schedule block removed. Coverage alerts updated.");
      render();
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function createTask(form) {
  const data = new FormData(form);
  app.data = await api("/api/tasks", {
    method: "POST",
    body: {
      title: data.get("title"),
      category: data.get("category"),
      group: data.get("group"),
      space: data.get("space"),
      dueDate: data.get("dueDate"),
      start: data.get("start"),
      end: data.get("end"),
      priority: data.get("priority"),
      requiredSkills: data.getAll("requiredSkills"),
      notes: data.get("notes")
    }
  });
  showToast("Task created and assigned.");
  render();
}

async function createEvents(form) {
  const data = new FormData(form);
  app.data = await api("/api/events", { method: "POST", body: { events: data.get("events") } });
  showToast("Event coverage tasks created.");
  render();
}

async function createSmartEvent(form) {
  const data = new FormData(form);
  app.data = await api("/api/schedule-events", {
    method: "POST",
    body: {
      title: data.get("title"),
      date: data.get("date"),
      space: data.get("space"),
      start: data.get("start"),
      end: data.get("end"),
      notes: data.get("notes")
    }
  });
  showToast("Event added. Student requests were created automatically.");
  render();
}

async function createCoverageBlock(form) {
  const data = new FormData(form);
  const eventId = form.dataset.eventId;
  app.data = await api(`/api/events/${encodeURIComponent(eventId)}/coverage-blocks`, {
    method: "POST",
    body: {
      start: data.get("start"),
      end: data.get("end"),
      mode: data.get("mode"),
      workerId: data.get("workerId")
    }
  });
  showToast(data.get("mode") === "covered" ? "Coverage block cleared." : "Coverage block request sent.");
  render();
}

async function createStaffSchedule(form) {
  const data = new FormData(form);
  app.data = await api("/api/staff-schedules", {
    method: "POST",
    body: {
      name: data.get("name"),
      day: data.get("day"),
      space: data.get("space"),
      start: data.get("start"),
      end: data.get("end"),
      notes: data.get("notes")
    }
  });
  showToast("Staff schedule added.");
  render();
}

async function createWorker(form) {
  const data = new FormData(form);
  app.data = await api("/api/workers", {
    method: "POST",
    body: {
      name: data.get("name"),
      initials: data.get("initials"),
      email: data.get("email"),
      primarySpace: data.get("primarySpace"),
      skills: data.getAll("skills")
    }
  });
  showToast("Student added. A student login was created.");
  render();
}

async function createUser(form) {
  const data = new FormData(form);
  app.data = await api("/api/users", {
    method: "POST",
    body: {
      name: data.get("name"),
      email: data.get("email"),
      role: data.get("role"),
      workerId: data.get("workerId"),
      password: data.get("password")
    }
  });
  showToast("Login saved.");
  render();
}

async function saveSkills(form) {
  const data = new FormData(form);
  const workerId = form.dataset.workerId || currentWorker()?.id;
  app.data = await api(`/api/workers/${encodeURIComponent(workerId)}/skills`, {
    method: "POST",
    body: { skills: data.getAll("skills"), customSkills: data.get("customSkills") }
  });
  showToast("Skills saved.");
  render();
}

async function saveSchedule(form) {
  const data = new FormData(form);
  app.data = await api("/api/schedules", {
    method: "POST",
    body: {
      workerId: data.get("workerId"),
      day: data.get("day"),
      space: data.get("space"),
      start: data.get("start"),
      end: data.get("end"),
      mode: data.get("mode"),
      slotIndex: data.get("slotIndex")
    }
  });
  app.editingSchedule = null;
  showToast("Schedule saved. Coverage alerts updated.");
  render();
}

async function setFocusDate(event) {
  if (!app.data) return;
  const focusDate = event.target.value;
  if (app.data.role !== "staff") {
    app.data.focusDate = focusDate;
    app.data.focusWeekStart = weekStartMonday(focusDate);
    render();
    return;
  }
  try {
    app.data = await api("/api/focus-date", { method: "POST", body: { focusDate } });
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function resetDemo() {
  if (!app.data || app.data.role !== "staff") return;
  try {
    app.data = await api("/api/reset", { method: "POST" });
    showToast("Demo data reset.");
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function taskForm() {
  return `
    <form id="taskForm" class="form-grid">
      <label class="span-3">Title<input name="title" required maxlength="160" placeholder="Cover PBIS check-in"></label>
      <label>Category${categorySelect()}</label>
      <label>Space${spaceSelect("space")}</label>
      <label>Priority${prioritySelect()}</label>
      <label>Due Date<input name="dueDate" type="date" value="${app.data.focusDate}" required></label>
      <label>Start<input name="start" type="time" value="09:00" required></label>
      <label>End<input name="end" type="time" value="17:00" required></label>
      <label class="span-3">Group or Event<input name="group" placeholder="PBIS, Pitch In, Chandler Endeavor"></label>
      <fieldset class="span-6 checkbox-panel">
        <legend>Needed Skills</legend>
        <div class="check-grid">${skillCheckboxes([], "requiredSkills")}</div>
      </fieldset>
      <label class="span-6">Notes<textarea name="notes" placeholder="Context, links, check-in details"></textarea></label>
      <div class="span-6 action-row"><button class="primary-button" type="submit">Create and Assign</button></div>
    </form>
  `;
}

function scheduleForm(workerId, includeWorkerSelect) {
  const editing = app.editingSchedule?.workerId === workerId ? app.editingSchedule : null;
  const worker = workerById(workerId);
  const editSlot = editing ? worker?.availability[editing.slotIndex] : null;
  const day = editSlot?.day || "Monday";
  const space = editSlot?.space || app.data.spaces[0]?.name || "1951@SkySong";
  const start = editSlot?.start || "09:00";
  const end = editSlot?.end || "17:00";
  return `
    <form id="scheduleForm" class="schedule-change-form">
      <div class="form-grid">
        ${includeWorkerSelect && !editSlot ? `<label class="span-2">Student${workerSelect(workerId)}</label>` : `<input type="hidden" name="workerId" value="${workerId}">${includeWorkerSelect ? `<label class="span-2">Student<input value="${escapeHtml(worker?.name || "Student")}" disabled></label>` : ""}`}
        ${editSlot ? `<input type="hidden" name="slotIndex" value="${editing.slotIndex}">` : ""}
        <label>Day${daySelect(day)}</label>
        <label>Space${spaceSelect("space", space)}</label>
        <label>Start<input name="start" type="time" value="${start}" required></label>
        <label>End<input name="end" type="time" value="${end}" required></label>
        <label class="span-2">Change Type
          <select name="mode">
            ${editSlot ? `<option value="edit-slot">Edit selected block</option>` : ""}
            <option value="replace-space" ${editSlot ? "" : "selected"}>Replace this space/day</option>
            <option value="add">Add block</option>
            <option value="replace-day">Replace full day</option>
          </select>
        </label>
        <div class="span-6 action-row">
          <button class="primary-button" type="submit">${editSlot ? "Save Edited Hours" : "Save Schedule"}</button>
          ${editSlot ? `<button class="ghost-button" type="button" data-action="clear-schedule-edit">Cancel Edit</button>` : ""}
        </div>
      </div>
    </form>
  `;
}

function taskCard(task) {
  const staff = app.data.role === "staff";
  const assigned = workerById(task.assignedTo)?.name || "Staff review needed";
  const canStudentAct = !staff && task.status !== "done";
  return `
    <article class="task-card">
      <div class="task-head">
        <h4>${escapeHtml(task.title)}</h4>
        ${statusPill(task.status)}
      </div>
      <div class="badge-row">
        ${spaceChip(task.space)}
        <span class="badge">${escapeHtml(task.category)}</span>
        <span class="badge">${formatShortDate(task.dueDate)}</span>
        <span class="badge">${formatTime(task.start)}-${formatTime(task.end)}</span>
        ${skillBadges(task.requiredSkills)}
      </div>
      <p class="task-meta">${staff ? `Assigned to ${escapeHtml(assigned)}. ` : ""}${escapeHtml(task.aiReason || "")}</p>
      <div class="task-footer">
        <span class="task-meta">${Math.round(task.confidence || 0)}% match</span>
        <div class="action-row">
          ${canStudentAct && task.status === "pending" ? taskButton(task, "accept", "Accept", "primary-button") : ""}
          ${canStudentAct && task.status === "accepted" ? taskButton(task, "complete", "Complete", "secondary-button") : ""}
          ${canStudentAct ? taskButton(task, "deny", "Deny", "danger-button") : ""}
          ${staff ? taskButton(task, "reassign", "Reassign", "mini-button") + taskButton(task, "mark-done", "Done", "mini-button") : ""}
        </div>
      </div>
    </article>
  `;
}

function taskButton(task, taskAction, label, className) {
  return `<button class="${className}" type="button" data-action="task-action" data-task-id="${task.id}" data-task-action="${taskAction}">${label}</button>`;
}

function requestButton(request, requestAction, label, className) {
  return `<button class="${className}" type="button" data-action="coverage-request" data-request-id="${request.id}" data-request-action="${requestAction}">${label}</button>`;
}

function workerCard(worker) {
  const availability = availabilityInFocusWeek(worker);
  return `
    <article class="task-card">
      <div class="task-head"><h4>${escapeHtml(worker.name)}</h4><span class="badge">${escapeHtml(worker.initials)}</span></div>
      <div class="badge-row">${worker.primarySpaces.map(spaceChip).join("")}</div>
      <div class="badge-row">${skillBadges(worker.skills)}</div>
      <p class="task-meta">${availability.length} schedule block${availability.length === 1 ? "" : "s"} this week · ${formatHours(worker.weeklyHours || 0)}/${formatHours(worker.weeklyLimit || 20)} hours</p>
    </article>
  `;
}

function workerSummaryRow(worker) {
  const active = app.data.tasks.filter((task) => task.assignedTo === worker.id && ["pending", "accepted"].includes(task.status)).length;
  const availability = availabilityInFocusWeek(worker);
  return `
    <tr>
      <td><strong>${escapeHtml(worker.name)}</strong><div class="task-meta">${escapeHtml(worker.primarySpaces.join(", "))}</div></td>
      <td><div class="badge-row">${skillBadges(worker.skills.slice(0, 5))}</div></td>
      <td>${active}</td>
      <td>${availability.length}<div class="task-meta">${formatHours(worker.weeklyHours || 0)}/${formatHours(worker.weeklyLimit || 20)}h</div></td>
    </tr>
  `;
}

function scheduleGrid() {
  const header = [`<div class="schedule-cell schedule-head">Student</div>`]
    .concat(DAYS.map((day, index) => `<div class="schedule-cell schedule-head">${day}<br>${formatShortDate(addDays(app.data.focusWeekStart, index))}</div>`))
    .join("");
  const rows = app.data.workers.map((worker) => {
    const cells = DAYS.map((day, dayIndex) => {
      const date = addDays(app.data.focusWeekStart, dayIndex);
      const slots = worker.availability
        .map((slot, index) => ({ slot, index }))
        .filter(({ slot }) => scheduleItemMatchesDate(slot, day, date));
      return `<div class="schedule-cell">${slots.length ? slots.map(({ slot, index }) => scheduleMiniCard(slot, worker, index, app.data.role === "staff" || app.data.currentUser.workerId === worker.id)).join("") : `<span class="task-meta">Off</span>`}</div>`;
    }).join("");
    return `<div class="schedule-cell worker-name">${escapeHtml(worker.name)}<div class="task-meta">${escapeHtml(worker.primarySpaces.join(", "))}</div></div>${cells}`;
  }).join("");
  return `<div class="schedule-grid">${header}${rows}</div>`;
}

function scheduleMiniCard(slot, worker, index, editable) {
  return `
    <article class="slot" style="color:${app.data.spaceColors[slot.space] || app.data.spaceColors.General}">
      <strong>${escapeHtml(slot.space)}</strong>
      <span>${formatTime(slot.start)}-${formatTime(slot.end)}</span>
      ${editable ? `<div class="slot-actions">
        <button class="mini-button slot-action" type="button" data-action="edit-schedule" data-worker-id="${worker.id}" data-slot-index="${index}">Edit</button>
        <button class="mini-button slot-action" type="button" data-action="remove-schedule" data-worker-id="${worker.id}" data-slot-index="${index}">Remove</button>
      </div>` : ""}
    </article>
  `;
}

function alertCard(alert) {
  return `
    <article class="alert-card ${escapeHtml(alert.level || "info")}">
      <strong>${escapeHtml(alert.title)}</strong>
      <span>${escapeHtml(alert.message)}</span>
    </article>
  `;
}

function gapToAlert(gap) {
  return {
    level: "warning",
    title: `Gap: ${gap.space}`,
    message: `No coverage on ${formatShortDate(gap.date)} from ${gap.detail}. ${gap.blocks?.length ? `Already covered: ${gap.blocks.join(", ")}.` : "Nobody is scheduled for that space that day."}`
  };
}

function spaceHoursRow(space) {
  const hours = DAYS.filter((day) => space.hours[day])
    .map((day) => `${day.slice(0, 3)} ${formatTime(space.hours[day][0])}-${formatTime(space.hours[day][1])}`)
    .join(", ");
  const closed = (space.closedDates || []).map(formatShortDate).join(", ");
  return `<tr><td>${spaceChip(space.name)}</td><td>${escapeHtml(space.campus)}</td><td>${escapeHtml(hours || "By event")}${closed ? `<div class="task-meta">Closed: ${escapeHtml(closed)}</div>` : ""}</td></tr>`;
}

function kpiCard(value, label) {
  return `<div class="kpi-card"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function currentWorker() {
  return app.data.workers.find((worker) => worker.id === app.data.currentUser.workerId);
}

function workerById(id) {
  return app.data.workers.find((worker) => worker.id === id);
}

function eventById(id) {
  return (app.data.events || []).find((event) => event.id === id);
}

function availabilityInFocusWeek(worker) {
  return (worker.availability || [])
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => scheduleItemInFocusWeek(slot))
    .sort((a, b) => (a.slot.date || "").localeCompare(b.slot.date || "") || DAYS.indexOf(a.slot.day) - DAYS.indexOf(b.slot.day) || minutes(a.slot.start) - minutes(b.slot.start) || a.slot.space.localeCompare(b.slot.space));
}

function scheduleItemInFocusWeek(item) {
  if (!item.date) return true;
  return item.date >= app.data.focusWeekStart && item.date <= addDays(app.data.focusWeekStart, 6);
}

function scheduleItemMatchesDate(item, day, date) {
  return item.day === day && (!item.date || item.date === date);
}

function eventsInFocusWeek(events) {
  const start = app.data.focusWeekStart;
  const end = addDays(start, 6);
  return [...events]
    .filter((event) => event.date >= start && event.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) || minutes(a.start) - minutes(b.start) || a.space.localeCompare(b.space));
}

function requestsInFocusWeek(requests) {
  return (requests || []).filter((request) => {
    const event = eventById(request.eventId);
    return event && eventsInFocusWeek([event]).length > 0;
  });
}

function studentRequestHint(requestOrStatus) {
  const request = typeof requestOrStatus === "object" ? requestOrStatus : null;
  const status = request?.status || requestOrStatus;
  if (status === "closed" && request?.reason) return request.reason;
  return {
    pending: "Can you cover this?",
    accepted: "Accepted. Add it to your schedule when ready.",
    scheduled: "This is now on your schedule.",
    denied: "You denied this request.",
    closed: "Another student accepted this one.",
    covered: "Staff cleared this event as covered.",
    dismissed: "Staff dismissed this coverage request."
  }[status] || status;
}

function projectedHoursForRequest(worker, event, request) {
  const limit = worker.weeklyLimit || 20;
  const current = Number(worker.weeklyHours || 0);
  const start = request.start || event.start;
  const end = request.end || event.end;
  const missingSegments = missingScheduleSegments(worker, event.date, start, end);
  const eventBlockHours = missingSegments.reduce((sum, segment) => sum + paidHoursForRange(segment.start, segment.end), 0);
  const alreadyScheduled = eventBlockHours <= 0 || hasExactSchedule(worker, event, request);
  const projected = request.status === "scheduled" || alreadyScheduled ? current : current + eventBlockHours;
  return {
    current,
    eventHours: eventBlockHours,
    projected,
    limit,
    alreadyScheduled
  };
}

function hourSummaryText(summary, status) {
  if (summary.alreadyScheduled || status === "scheduled") {
    return `Already covered on your schedule. Weekly total: ${formatHours(summary.current)}/${formatHours(summary.limit)} hours.`;
  }
  const projectedText = `${formatHours(summary.projected)}/${formatHours(summary.limit)} hours`;
  if (summary.projected > summary.limit) {
    return `This adds ${formatHours(summary.eventHours)} hours and would put you at ${projectedText}. Edit your schedule before adding it.`;
  }
  return `This adds ${formatHours(summary.eventHours)} hours. Projected weekly total: ${projectedText}.`;
}

function hasExactSchedule(worker, event, request = {}) {
  const day = dayFromDate(event.date);
  const start = request.start || event.start;
  const end = request.end || event.end;
  return worker.availability.some((slot) =>
    scheduleItemMatchesDate(slot, day, event.date) &&
    slot.space === event.space &&
    slot.start === start &&
    slot.end === end
  );
}

function missingScheduleSegments(worker, date, start, end) {
  const day = dayFromDate(date);
  const startMinute = minutes(start);
  const endMinute = minutes(end);
  const covered = (worker.availability || [])
    .filter((slot) => scheduleItemMatchesDate(slot, day, date))
    .map((slot) => ({
      start: Math.max(startMinute, minutes(slot.start)),
      end: Math.min(endMinute, minutes(slot.end))
    }))
    .filter((slot) => slot.end > slot.start)
    .sort((a, b) => a.start - b.start);
  const missing = [];
  let cursor = startMinute;

  covered.forEach((slot) => {
    if (slot.start > cursor) missing.push({ start: timeFromMinutes(cursor), end: timeFromMinutes(slot.start) });
    if (slot.end > cursor) cursor = slot.end;
  });
  if (cursor < endMinute) missing.push({ start: timeFromMinutes(cursor), end: timeFromMinutes(endMinute) });
  return missing;
}

function requestTimeLabel(request, event) {
  return `${formatTime(request.start || event.start)}-${formatTime(request.end || event.end)}`;
}

function dayFromDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return DAYS[date.getDay() === 0 ? 6 : date.getDay() - 1] || "";
}

function afterHoursCoverageResolved(event) {
  if (event.coverageBlocks?.length) {
    return coverageBlocksCoverEvent(event) && event.coverageBlocks.every((block) =>
      ["covered", "scheduled", "rejected"].includes(block.status)
    );
  }
  return ["scheduled", "covered", "rejected"].includes(event.status);
}

function coverageBlocksCoverEvent(event) {
  const eventStart = minutes(event.start);
  const eventEnd = minutes(event.end);
  const blocks = (event.coverageBlocks || [])
    .map((block) => ({ start: minutes(block.start), end: minutes(block.end) }))
    .filter((block) => block.end > block.start)
    .sort((a, b) => a.start - b.start);
  let cursor = eventStart;

  for (const block of blocks) {
    if (block.start > cursor) return false;
    if (block.end > cursor) cursor = block.end;
    if (cursor >= eventEnd) return true;
  }
  return cursor >= eventEnd;
}

function hoursBetween(start, end) {
  return Math.max(0, minutes(end) - minutes(start)) / 60;
}

function paidHoursForRange(start, end) {
  const hours = hoursBetween(start, end);
  return hours >= 9 ? hours - 1 : hours;
}

function minutes(time) {
  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(total) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatHours(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function categorySelect() {
  return `<select name="category">
    ${["WorldLabs Post", "Data Pull", "Event Coverage", "On-site Coverage", "Supervisor Task"].map((item) => `<option>${item}</option>`).join("")}
  </select>`;
}

function prioritySelect() {
  return `<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select>`;
}

function spaceSelect(name, selected = "") {
  const options = [...app.data.spaces.map((space) => space.name), "General"];
  return `<select name="${name}">${options.map((space) => `<option ${space === selected ? "selected" : ""}>${escapeHtml(space)}</option>`).join("")}</select>`;
}

function daySelect(selected = "") {
  return `<select name="day">${DAYS.map((day) => `<option ${day === selected ? "selected" : ""}>${day}</option>`).join("")}</select>`;
}

function workerSelect(selectedId) {
  return `<select name="workerId">${app.data.workers.map((worker) => `<option value="${worker.id}" ${worker.id === selectedId ? "selected" : ""}>${escapeHtml(worker.name)}</option>`).join("")}</select>`;
}

function workerSelectWithBlank(selectedId, blankLabel = "Staff login") {
  return `<select name="workerId">
    <option value="">${escapeHtml(blankLabel)}</option>
    ${app.data.workers.map((worker) => `<option value="${worker.id}" ${worker.id === selectedId ? "selected" : ""}>${escapeHtml(worker.name)}</option>`).join("")}
  </select>`;
}

function userRow(user) {
  const worker = app.data.workers.find((item) => item.id === user.workerId);
  return `
    <tr>
      <td><strong>${escapeHtml(user.name)}</strong></td>
      <td>${escapeHtml(user.email)}</td>
      <td>${user.role === "staff" ? statusPill("accepted").replace("Accepted", "Staff") : statusPill("scheduled").replace("Scheduled", "Student")}</td>
      <td>${worker ? escapeHtml(worker.name) : "-"}</td>
    </tr>
  `;
}

function skillCheckboxes(selected, name) {
  const values = new Set(selected || []);
  return app.data.skillOptions.map((skill) => `
    <label class="check-pill">
      <input type="checkbox" name="${name}" value="${skill.id}" ${values.has(skill.id) ? "checked" : ""}>
      <span>${escapeHtml(skill.label)}</span>
    </label>
  `).join("");
}

function skillBadges(skills) {
  return (skills || []).map((skill) => `<span class="badge skill-badge">${escapeHtml(skillLabel(skill))}</span>`).join("");
}

function skillLabel(skill) {
  return app.data.skillOptions.find((item) => item.id === skill)?.label || titleCase(String(skill).replace(/-/g, " "));
}

function statusPill(status) {
  const label = { pending: "Pending", accepted: "Accepted", scheduled: "Scheduled", covered: "Covered", rejected: "Rejected", dismissed: "Dismissed", requesting: "Requesting", closed: "Closed", "needs-review": "Needs Review", done: "Complete", denied: "Denied", unassigned: "Needs Assignment", draft: "Draft" }[status] || status;
  return `<span class="status-pill ${status}">${label}</span>`;
}

function spaceChip(space) {
  const color = app.data.spaceColors[space] || app.data.spaceColors.General;
  return `<span class="space-chip" style="color:${color}">${escapeHtml(space)}</span>`;
}

function eventRoomLabel(event) {
  return String(event?.mazevoRoomDescription || "").trim();
}

function eventRoomExportLabel(event) {
  const building = String(event?.mazevoBuildingDescription || "").trim();
  const room = eventRoomLabel(event);
  return [building, room].filter(Boolean).join(" / ");
}

function eventRoomBadge(event) {
  const room = eventRoomLabel(event);
  return room ? `<span class="badge">${escapeHtml(room)}</span>` : "";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function formatTime(time) {
  if (!time) return "";
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")}${suffix}`;
}

function formatShortDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return date.toISOString().slice(0, 10);
}

function weekStartMonday(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeScheduleName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeScheduleSpace(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

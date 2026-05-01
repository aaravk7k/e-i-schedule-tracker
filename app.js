const app = {
  data: null,
  view: "dashboard",
  selectedWorkerId: "",
  toastTimer: null
};

const staffViews = [
  ["dashboard", "Dashboard"],
  ["tasks", "Tasks"],
  ["people", "Students"],
  ["schedules", "Schedules"],
  ["spaces", "Spaces"],
  ["airtable", "Airtable"]
];

const studentViews = [
  ["my-tasks", "My Tasks"],
  ["profile", "My Profile"],
  ["schedules", "Schedules"],
  ["spaces", "Spaces"]
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
  app.view = app.data.role === "staff" ? "dashboard" : "my-tasks";
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
        <p class="eyebrow">Edson E+I TaskOps</p>
        <h3>Sign in to continue</h3>
        <p class="microcopy">Staff and students use different accounts. Students only see their own tasks plus shared schedules and space coverage.</p>
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
  else app.view = data.role === "staff" ? "dashboard" : "my-tasks";
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

  const viewTitle = availableViews().find(([id]) => id === app.view)?.[1] || "TaskOps";
  document.getElementById("viewTitle").textContent = viewTitle;
  const region = document.getElementById("appView");

  if (app.data.role === "staff" && app.view === "dashboard") region.innerHTML = renderStaffDashboard();
  if (app.data.role === "staff" && app.view === "tasks") region.innerHTML = renderTaskManager();
  if (app.data.role === "staff" && app.view === "people") region.innerHTML = renderPeople();
  if (app.data.role === "staff" && app.view === "airtable") region.innerHTML = renderAirtable();
  if (app.view === "my-tasks") region.innerHTML = renderMyTasks();
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

function renderMyTasks() {
  const tasks = app.data.tasks || [];
  const active = tasks.filter((task) => task.status !== "done");
  const done = tasks.filter((task) => task.status === "done");
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

function renderProfile() {
  const worker = currentWorker();
  if (!worker) return emptyState("No student profile linked to this login.");
  return `
    <section class="split-grid">
      <div class="panel">
        <h3>My Skills</h3>
        <form id="skillForm" class="skill-form" data-worker-id="${worker.id}">
          <div class="check-grid">${skillCheckboxes(worker.skills, "skills")}</div>
          <label class="stacked-field">Add Other Skill<input name="customSkills" placeholder="Canva, inventory, email replies"></label>
          <div class="action-row"><button class="primary-button" type="submit">Save Skills</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>My Schedule</h3>
        <div class="task-list">${worker.availability.length ? worker.availability.map((slot, index) => scheduleMiniCard(slot, worker, index, true)).join("") : emptyState("No schedule blocks yet.")}</div>
        ${scheduleForm(worker.id, false)}
      </div>
    </section>
  `;
}

function renderSchedules() {
  const staff = app.data.role === "staff";
  return `
    <section class="band">
      <div class="band-header">
        <div>
          <p class="eyebrow">Shared Schedule</p>
          <h3>Student Worker Coverage</h3>
        </div>
      </div>
      ${staff ? `<div class="panel"><h3>Add or Change Schedule</h3>${scheduleForm(app.data.workers[0]?.id, true)}</div>` : ""}
      <div class="panel">
        <h3>Coverage Alerts</h3>
        ${app.data.coverageGaps.length ? `<div class="alert-stack">${app.data.coverageGaps.map((gap) => alertCard(gapToAlert(gap))).join("")}</div>` : emptyState("All spaces are covered for configured business hours.")}
      </div>
      <div class="panel flush">
        <div class="table-wrap">${scheduleGrid()}</div>
      </div>
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

function renderAirtable() {
  const status = app.data.airtable || {};
  const configured = status.configured;
  const summary = status.lastSyncSummary;
  return `
    <section class="split-grid">
      <div class="panel">
        <h3>Airtable Connection</h3>
        <div class="task-list">
          <article class="task-card">
            <div class="task-head">
              <h4>${configured ? "Connected" : "Not Connected Yet"}</h4>
              <span class="status-pill ${configured ? "done" : "unassigned"}">${configured ? "Ready" : "Needs Setup"}</span>
            </div>
            <p class="task-meta">${configured ? `Base ${escapeHtml(status.baseId)} is configured.` : `Missing: ${escapeHtml((status.missing || []).join(", ") || "Airtable environment variables")}`}</p>
            <div class="badge-row">
              ${Object.entries(status.tables || {}).map(([key, table]) => `<span class="badge">${escapeHtml(key)}: ${escapeHtml(table)}</span>`).join("")}
            </div>
            <div class="action-row">
              <button class="primary-button" type="button" data-action="sync-airtable" ${configured ? "" : "disabled"}>Push Current Data to Airtable</button>
            </div>
          </article>
        </div>
      </div>
      <div class="panel">
        <h3>How To Set It Up</h3>
        <div class="plain-list">
          <p>1. Create four Airtable tables: Tasks, Students, Schedules, Spaces.</p>
          <p>2. Add a text field called External ID to every table.</p>
          <p>3. Create a Personal Access Token in Airtable with read/write record access to your base.</p>
          <p>4. Add the token and base ID as server environment variables.</p>
        </div>
      </div>
    </section>
    <section class="panel">
      <h3>Last Sync</h3>
      ${summary ? `<div class="table-wrap"><table><thead><tr><th>Table</th><th>Created</th><th>Updated</th></tr></thead><tbody>${Object.entries(summary).filter(([key]) => key !== "total").map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${value.created}</td><td>${value.updated}</td></tr>`).join("")}</tbody></table></div><p class="task-meta">Last synced: ${escapeHtml(status.lastSyncAt || "")}</p>` : emptyState("No Airtable sync has run yet.")}
    </section>
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

  bindForm("taskForm", createTask);
  bindForm("eventForm", createEvents);
  bindForm("workerForm", createWorker);
  bindForm("skillForm", saveSkills);
  bindForm("scheduleForm", saveSchedule);
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
    if (action === "sync-airtable") {
      app.data = await api("/api/airtable/sync-push", { method: "POST" });
      showToast("Current data pushed to Airtable.");
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
    if (action === "remove-schedule") {
      const workerId = button.dataset.workerId;
      const index = button.dataset.slotIndex;
      app.data = await api(`/api/workers/${encodeURIComponent(workerId)}/schedules/${index}`, { method: "DELETE" });
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
      mode: data.get("mode")
    }
  });
  showToast("Schedule saved. Coverage alerts updated.");
  render();
}

async function setFocusDate(event) {
  if (!app.data || app.data.role !== "staff") return;
  try {
    app.data = await api("/api/focus-date", { method: "POST", body: { focusDate: event.target.value } });
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
  return `
    <form id="scheduleForm" class="schedule-change-form">
      <div class="form-grid">
        ${includeWorkerSelect ? `<label class="span-2">Student${workerSelect(workerId)}</label>` : `<input type="hidden" name="workerId" value="${workerId}">`}
        <label>Day${daySelect()}</label>
        <label>Space${spaceSelect("space")}</label>
        <label>Start<input name="start" type="time" value="09:00" required></label>
        <label>End<input name="end" type="time" value="17:00" required></label>
        <label class="span-2">Change Type
          <select name="mode">
            <option value="replace-space">Replace this space/day</option>
            <option value="add">Add block</option>
            <option value="replace-day">Replace full day</option>
          </select>
        </label>
        <div class="span-6 action-row"><button class="primary-button" type="submit">Save Schedule</button></div>
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

function workerCard(worker) {
  return `
    <article class="task-card">
      <div class="task-head"><h4>${escapeHtml(worker.name)}</h4><span class="badge">${escapeHtml(worker.initials)}</span></div>
      <div class="badge-row">${worker.primarySpaces.map(spaceChip).join("")}</div>
      <div class="badge-row">${skillBadges(worker.skills)}</div>
      <p class="task-meta">${worker.availability.length} schedule block${worker.availability.length === 1 ? "" : "s"}</p>
    </article>
  `;
}

function workerSummaryRow(worker) {
  const active = app.data.tasks.filter((task) => task.assignedTo === worker.id && ["pending", "accepted"].includes(task.status)).length;
  return `
    <tr>
      <td><strong>${escapeHtml(worker.name)}</strong><div class="task-meta">${escapeHtml(worker.primarySpaces.join(", "))}</div></td>
      <td><div class="badge-row">${skillBadges(worker.skills.slice(0, 5))}</div></td>
      <td>${active}</td>
      <td>${worker.availability.length}</td>
    </tr>
  `;
}

function scheduleGrid() {
  const header = [`<div class="schedule-cell schedule-head">Student</div>`]
    .concat(DAYS.map((day, index) => `<div class="schedule-cell schedule-head">${day}<br>${formatShortDate(addDays(app.data.focusWeekStart, index))}</div>`))
    .join("");
  const rows = app.data.workers.map((worker) => {
    const cells = DAYS.map((day) => {
      const slots = worker.availability.filter((item) => item.day === day);
      return `<div class="schedule-cell">${slots.length ? slots.map((slot) => scheduleMiniCard(slot, worker, worker.availability.indexOf(slot), app.data.role === "staff" || app.data.currentUser.workerId === worker.id)).join("") : `<span class="task-meta">Off</span>`}</div>`;
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
      ${editable ? `<button class="mini-button slot-action" type="button" data-action="remove-schedule" data-worker-id="${worker.id}" data-slot-index="${index}">Remove</button>` : ""}
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
    title: `${gap.space} needs coverage`,
    message: `${formatShortDate(gap.date)} from ${gap.detail}. ${gap.blocks?.length ? `Other scheduled times: ${gap.blocks.join(", ")}.` : "Nobody is scheduled for that space that day."}`
  };
}

function spaceHoursRow(space) {
  const hours = DAYS.filter((day) => space.hours[day])
    .map((day) => `${day.slice(0, 3)} ${formatTime(space.hours[day][0])}-${formatTime(space.hours[day][1])}`)
    .join(", ");
  return `<tr><td>${spaceChip(space.name)}</td><td>${escapeHtml(space.campus)}</td><td>${escapeHtml(hours || "By event")}</td></tr>`;
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

function categorySelect() {
  return `<select name="category">
    ${["WorldLabs Post", "Data Pull", "Event Coverage", "On-site Coverage", "Supervisor Task"].map((item) => `<option>${item}</option>`).join("")}
  </select>`;
}

function prioritySelect() {
  return `<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select>`;
}

function spaceSelect(name) {
  return `<select name="${name}">${app.data.spaces.map((space) => `<option>${escapeHtml(space.name)}</option>`).join("")}<option>General</option></select>`;
}

function daySelect() {
  return `<select name="day">${DAYS.map((day) => `<option>${day}</option>`).join("")}</select>`;
}

function workerSelect(selectedId) {
  return `<select name="workerId">${app.data.workers.map((worker) => `<option value="${worker.id}" ${worker.id === selectedId ? "selected" : ""}>${escapeHtml(worker.name)}</option>`).join("")}</select>`;
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
  const label = { pending: "Pending", accepted: "Accepted", done: "Complete", denied: "Denied", unassigned: "Needs Assignment", draft: "Draft" }[status] || status;
  return `<span class="status-pill ${status}">${label}</span>`;
}

function spaceChip(space) {
  const color = app.data.spaceColors[space] || app.data.spaceColors.General;
  return `<span class="space-chip" style="color:${color}">${escapeHtml(space)}</span>`;
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

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return date.toISOString().slice(0, 10);
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (char) => char.toUpperCase());
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

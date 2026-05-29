const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const seedData = require("./seed-data/current-week.json");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "db.json");
const COOKIE_NAME = "schedule_manager_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const AIRTABLE_API_URL = "https://api.airtable.com/v0";
const AIRTABLE_TABLES = {
  tasks: process.env.AIRTABLE_TABLE_TASKS || "Tasks",
  workers: process.env.AIRTABLE_TABLE_STUDENTS || "Students",
  schedules: process.env.AIRTABLE_TABLE_SCHEDULES || "Schedules",
  spaces: process.env.AIRTABLE_TABLE_SPACES || "Spaces"
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SOURCE_WEEK_START = "2026-05-25";
const FALLBACK_FOCUS_DATE = "2026-05-27";
const CURRENT_SEED_VERSION = "pbis-summer-2026-access-logins";
const WEEKLY_HOUR_LIMIT = Number(process.env.STUDENT_WEEKLY_HOUR_LIMIT || 40);

const SKILL_OPTIONS = [
  { id: "administrative", label: "Administrative" },
  { id: "graphic-design", label: "Graphic Design" },
  { id: "communications", label: "Communications" },
  { id: "customer-service", label: "Front Desk" },
  { id: "events", label: "Event Coverage" },
  { id: "worldlabs", label: "WorldLabs" },
  { id: "data", label: "Data + Reporting" },
  { id: "coverage", label: "Space Coverage" },
  { id: "operations", label: "Operations" }
];

const SKILL_LABELS = Object.fromEntries(SKILL_OPTIONS.map((skill) => [skill.id, skill.label]));

const CATEGORY_SKILLS = {
  "WorldLabs Post": "worldlabs",
  "Data Pull": "data",
  "Event Coverage": "events",
  "On-site Coverage": "customer-service",
  "Supervisor Task": "operations"
};

const SPACE_COLORS = {
  "1951@SkySong": "#8c1d40",
  "850PBC": "#c68a00",
  "ACIC": "#177e89",
  "SkySong": "#005c5c",
  "The Studios": "#2f7d32",
  "Fusion on First": "#7a3e9d",
  "WorldLabs Remote": "#344054",
  "General": "#667085"
};

const SPACE_OWNER_WORKER_IDS = {
  "1951@SkySong": "amanda",
  "850PBC": "palash",
  ACIC: "deepinderjit-singh",
  "The Studios": "shreyas",
  SkySong: "aarav-kapoor"
};

const sessions = new Map();
let db;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.status ? error.message : "Server error" });
  }
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const user = getUserFromRequest(req);

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    const found = db.users.find((item) => item.email.toLowerCase() === cleanText(body.email).toLowerCase());
    if (!found || !verifyPassword(cleanText(body.password), found.password)) {
      sendJson(res, 401, { error: "Invalid email or password" });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: found.id, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    sendJson(res, 200, { ok: true, user: publicUser(found) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = getCookie(req, COOKIE_NAME);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!user) {
    sendJson(res, 401, { error: "Not signed in" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/schedule-events") {
    requireStaff(user);
    const body = await readJson(req);
    const event = createScheduleEvent(body);
    if (!event.title || !event.date) {
      sendJson(res, 400, { error: "Event title and date are required" });
      return;
    }
    db.events.push(event);
    if (!event.afterHours) event.status = "scheduled";
    const requests = event.afterHours ? createCoverageRequestsForEvent(event, db) : [];
    addActivity(event.afterHours
      ? `Added after-hours event "${event.title}" and suggested ${requests.length} student worker${requests.length === 1 ? "" : "s"}.`
      : `Added in-hours booking "${event.title}".`);
    saveDb();
    sendJson(res, 201, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/staff-schedules") {
    requireStaff(user);
    const body = await readJson(req);
    const staffSchedule = createStaffSchedule(body);
    db.staffSchedules.push(staffSchedule);
    addAlert("info", "Staff schedule added", `${staffSchedule.name} is listed at ${staffSchedule.space} on ${staffSchedule.day}, ${formatTime(staffSchedule.start)}-${formatTime(staffSchedule.end)}.`);
    addActivity(`Added staff schedule for ${staffSchedule.name}.`);
    saveDb();
    sendJson(res, 201, viewForUser(user));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/airtable/status") {
    requireStaff(user);
    sendJson(res, 200, airtableStatus());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/airtable/sync-push") {
    requireStaff(user);
    if (!airtableConfigured()) {
      sendJson(res, 400, { error: "Airtable is not configured. Set AIRTABLE_PAT and AIRTABLE_BASE_ID." });
      return;
    }
    const summary = await pushDbToAirtable();
    db.airtable ||= {};
    db.airtable.lastSyncAt = new Date().toISOString();
    db.airtable.lastSyncSummary = summary;
    addAlert("info", "Airtable synced", `Pushed ${summary.total} records to Airtable.`);
    addActivity(`Pushed ${summary.total} records to Airtable.`);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    requireStaff(user);
    const body = await readJson(req);
    const task = createTask({
      title: body.title,
      category: body.category,
      group: body.group,
      space: body.space,
      dueDate: body.dueDate,
      start: body.start,
      end: body.end,
      priority: body.priority,
      requiredSkills: body.requiredSkills,
      notes: body.notes,
      source: "Staff-created"
    });
    assignTask(task, db, { honorPreferred: false });
    db.tasks.push(task);
    db.tasks.sort(sortTasks);
    addActivity(`Created task "${task.title}" and assigned ${assignmentLabel(task)}.`);
    saveDb();
    sendJson(res, 201, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/events") {
    requireStaff(user);
    const body = await readJson(req);
    const parsedEvents = parseEventList(body.events);
    parsedEvents.forEach((eventTask, index) => {
      const task = createTask({
        id: `event-${Date.now()}-${index}`,
        title: eventTask.title,
        category: "Event Coverage",
        group: eventTask.title,
        space: eventTask.space,
        dueDate: eventTask.dueDate,
        start: eventTask.start,
        end: eventTask.end,
        priority: "High",
        requiredSkills: eventTask.requiredSkills,
        source: "Event coverage planner"
      });
      assignTask(task, db, { honorPreferred: false });
      db.tasks.push(task);
    });
    db.tasks.sort(sortTasks);
    addAlert("info", "Event coverage created", `${parsedEvents.length} event coverage task${parsedEvents.length === 1 ? "" : "s"} assigned.`);
    addActivity(`Created ${parsedEvents.length} event coverage tasks.`);
    saveDb();
    sendJson(res, 201, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assign") {
    requireStaff(user);
    let count = 0;
    db.tasks.forEach((task) => {
      if (task.status !== "done" && task.status !== "accepted") {
        task.assignedTo = "";
        task.status = "draft";
        assignTask(task, db, { honorPreferred: false });
        count += 1;
      }
    });
    db.tasks.sort(sortTasks);
    addActivity(`Re-ran assignment on ${count} open tasks.`);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/focus-date") {
    requireStaff(user);
    const body = await readJson(req);
    const focusDate = normalizeDateValue(body.focusDate);
    if (!focusDate) {
      sendJson(res, 400, { error: "Invalid focus date" });
      return;
    }
    db.focusDate = focusDate;
    db.focusWeekStart = weekStartMonday(focusDate);
    ensureCoverageRequestsForFocusWeek(db);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate-worldlabs") {
    requireStaff(user);
    const body = await readJson(req).catch(() => ({}));
    const focusDate = normalizeDateValue(body.focusDate) || db.focusDate || FALLBACK_FOCUS_DATE;
    const existing = new Set(db.tasks.map((task) => `${task.title}|${task.dueDate}`));
    let added = 0;
    sourceTaskTemplates.forEach((template, index) => {
      const task = normalizeTemplateTask({ ...template, dueOffset: (template.dueOffset || 0) + 7 }, index + db.tasks.length + 1000, focusDate);
      const key = `${task.title}|${task.dueDate}`;
      if (existing.has(key)) return;
      assignTask(task, db, { honorPreferred: true });
      db.tasks.push(task);
      added += 1;
    });
    db.tasks.sort(sortTasks);
    addActivity(`Generated ${added} WorldLabs tasks from calendar templates.`);
    saveDb();
    sendJson(res, 201, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workers") {
    requireStaff(user);
    const body = await readJson(req);
    const name = cleanText(body.name);
    const id = slugify(name);
    if (!name || db.workers.some((worker) => worker.id === id)) {
      sendJson(res, 400, { error: "Student name is missing or already exists" });
      return;
    }
    const worker = {
      id,
      name,
      role: "Student Worker",
      initials: cleanText(body.initials) || initialsFromName(name),
      supervisor: cleanText(body.supervisor) || "Unassigned",
      primarySpaces: [normalizeSpaceName(body.primarySpace || "General")],
      skills: normalizeSkillList(body.skills || ["customer-service", "coverage"]),
      availability: []
    };
    db.workers.push(worker);
    db.users.push(createSeedUser({
      id: `user-${id}`,
      email: cleanText(body.email) || `${id}@ei.asu.edu`,
      name,
      role: "student",
      workerId: id,
      password: process.env.STUDENT_DEFAULT_PASSWORD || "edson-student"
    }));
    addActivity(`Added student worker ${worker.name}.`);
    saveDb();
    sendJson(res, 201, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    requireStaff(user);
    const body = await readJson(req);
    const login = createOrUpdateUser(body);
    addActivity(`${login.action} ${login.user.role} login for ${login.user.name}.`);
    saveDb();
    sendJson(res, login.created ? 201 : 200, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/schedules") {
    const body = await readJson(req);
    const workerId = user.role === "staff" ? cleanText(body.workerId) : user.workerId;
    const worker = db.workers.find((item) => item.id === workerId);
    if (!worker) {
      sendJson(res, 404, { error: "Worker not found" });
      return;
    }
    applyScheduleChange(worker, {
      day: body.day,
      space: body.space,
      start: body.start,
      end: body.end,
      mode: body.mode,
      slotIndex: body.slotIndex,
      source: user.role === "staff" ? "Staff schedule edit" : "Student schedule change",
      by: user.name
    });
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  const skillMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/skills$/);
  if (req.method === "POST" && skillMatch) {
    const workerId = decodeURIComponent(skillMatch[1]);
    if (user.role !== "staff" && user.workerId !== workerId) {
      sendJson(res, 403, { error: "Students can only update their own skills" });
      return;
    }
    const worker = db.workers.find((item) => item.id === workerId);
    if (!worker) {
      sendJson(res, 404, { error: "Worker not found" });
      return;
    }
    const body = await readJson(req);
    worker.skills = normalizeSkillList([...(body.skills || []), ...splitSkillInput(body.customSkills || "")]);
    addAlert("info", "Skill profile changed", `${worker.name} updated their skills.`);
    addActivity(`${worker.name} updated skills: ${worker.skills.map(skillLabel).join(", ")}.`);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  const removeScheduleMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/schedules\/(\d+)$/);
  if (req.method === "DELETE" && removeScheduleMatch) {
    const workerId = decodeURIComponent(removeScheduleMatch[1]);
    const slotIndex = Number(removeScheduleMatch[2]);
    if (user.role !== "staff" && user.workerId !== workerId) {
      sendJson(res, 403, { error: "Students can only edit their own schedule" });
      return;
    }
    const worker = db.workers.find((item) => item.id === workerId);
    if (!worker || !worker.availability[slotIndex]) {
      sendJson(res, 404, { error: "Schedule block not found" });
      return;
    }
    const removed = worker.availability.splice(slotIndex, 1)[0];
    addAlert("warning", "Schedule removed", `${worker.name} removed ${removed.space} on ${removed.day}, ${formatTime(removed.start)}-${formatTime(removed.end)}.`);
    addActivity(`Removed ${worker.name} schedule block at ${removed.space}.`);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  const taskActionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/action$/);
  if (req.method === "POST" && taskActionMatch) {
    const task = db.tasks.find((item) => item.id === decodeURIComponent(taskActionMatch[1]));
    if (!task) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    const body = await readJson(req);
    const action = cleanText(body.action);
    if (user.role === "student" && task.assignedTo !== user.workerId) {
      sendJson(res, 403, { error: "Students can only update tasks assigned to them" });
      return;
    }
    if (user.role === "student" && !["accept", "complete", "deny"].includes(action)) {
      sendJson(res, 403, { error: "Action not allowed" });
      return;
    }
    handleTaskAction(task, action, user);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  const coverageRequestMatch = url.pathname.match(/^\/api\/coverage-requests\/([^/]+)\/action$/);
  if (req.method === "POST" && coverageRequestMatch) {
    const request = db.coverageRequests.find((item) => item.id === decodeURIComponent(coverageRequestMatch[1]));
    if (!request) {
      sendJson(res, 404, { error: "Coverage request not found" });
      return;
    }
    const body = await readJson(req);
    const action = cleanText(body.action);
    if (user.role !== "student" || request.workerId !== user.workerId) {
      sendJson(res, 403, { error: "Students can only update their own coverage requests" });
      return;
    }
    if (!["accept", "deny", "add-to-schedule"].includes(action)) {
      sendJson(res, 400, { error: "Action not allowed" });
      return;
    }
    handleCoverageRequestAction(request, action, user);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    requireStaff(user);
    db = createInitialDb();
    saveDb();
    sendJson(res, 200, viewForUser(db.users[0]));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function handleTaskAction(task, action, user) {
  if (action === "accept") {
    task.status = "accepted";
    task.acceptedAt = new Date().toISOString();
    addActivity(`${assignmentLabel(task)} accepted "${task.title}".`);
    return;
  }
  if (action === "complete" || action === "mark-done") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    addActivity(`${user.role === "staff" ? user.name : assignmentLabel(task)} completed "${task.title}".`);
    return;
  }
  if (action === "deny") {
    if (task.assignedTo && !task.deniedBy.includes(task.assignedTo)) task.deniedBy.push(task.assignedTo);
    const prior = assignmentLabel(task);
    task.assignedTo = "";
    task.status = "draft";
    assignTask(task, db, { honorPreferred: false });
    addActivity(`${prior} denied "${task.title}"; reassigned ${assignmentLabel(task)}.`);
    return;
  }
  if (action === "reassign") {
    requireStaff(user);
    task.assignedTo = "";
    task.status = "draft";
    assignTask(task, db, { honorPreferred: false });
    addActivity(`Reassigned "${task.title}" to ${assignmentLabel(task)}.`);
  }
}

function handleCoverageRequestAction(request, action, user) {
  const event = db.events.find((item) => item.id === request.eventId);
  const worker = db.workers.find((item) => item.id === request.workerId);
  if (!event || !worker) {
    const error = new Error("Coverage request is missing event or worker data");
    error.status = 404;
    throw error;
  }

  if (action === "accept") {
    request.status = "accepted";
    request.respondedAt = new Date().toISOString();
    event.status = "accepted";
    event.assignedTo = worker.id;
    db.coverageRequests
      .filter((item) => item.eventId === event.id && item.id !== request.id && item.status === "pending")
      .forEach((item) => {
        item.status = "closed";
        item.respondedAt = new Date().toISOString();
      });
    addAlert("info", "Coverage accepted", `${worker.name} accepted ${event.title} at ${event.space}, ${formatShortDate(event.date)} ${formatTime(event.start)}-${formatTime(event.end)}.`);
    addActivity(`${worker.name} accepted after-hours coverage for "${event.title}".`);
    return;
  }

  if (action === "deny") {
    request.status = "denied";
    request.respondedAt = new Date().toISOString();
    const openRequests = db.coverageRequests.filter((item) => item.eventId === event.id && ["pending", "accepted", "scheduled"].includes(item.status));
    if (!openRequests.length) event.status = "needs-review";
    addAlert("warning", "Coverage denied", `${worker.name} denied ${event.title}. ${openRequests.length ? "Other requests are still open." : "Supervisor review needed."}`);
    addActivity(`${worker.name} denied coverage for "${event.title}".`);
    return;
  }

  if (action === "add-to-schedule") {
    if (!["accepted", "scheduled"].includes(request.status)) {
      const error = new Error("Accept the coverage request before adding it to your schedule");
      error.status = 400;
      throw error;
    }
    const day = dayFromDate(event.date);
  const alreadyScheduled = worker.availability.some((slotItem) =>
    scheduleItemMatchesDate(slotItem, day, event.date) &&
    slotItem.space === event.space &&
    slotItem.start === event.start &&
    slotItem.end === event.end
    );
    if (!alreadyScheduled) {
      applyScheduleChange(worker, {
        date: event.date,
        day,
        space: event.space,
        start: event.start,
        end: event.end,
        mode: "add",
        source: "Accepted event coverage",
        by: user.name
      });
    }
    request.status = "scheduled";
    request.respondedAt = new Date().toISOString();
    event.status = "scheduled";
    event.assignedTo = worker.id;
    addAlert("info", "Event added to schedule", `${worker.name} added ${event.title} to their schedule. Supervisors can now see it on the weekly board.`);
    addActivity(`${worker.name} added "${event.title}" to their schedule.`);
  }
}

function viewForUser(user) {
  const coverageGaps = getCoverageGaps();
  const coverageSuggestions = getCoverageSuggestions(coverageGaps);
  const currentUser = publicUser(user);
  const base = {
    currentUser,
    role: user.role,
    focusDate: db.focusDate,
    focusWeekStart: db.focusWeekStart,
    spaces: db.spaces,
    events: db.events.map(publicEvent),
    staffSchedules: db.staffSchedules,
    spaceColors: SPACE_COLORS,
    skillOptions: SKILL_OPTIONS,
    workers: db.workers.map((worker) => publicWorker(worker, user.role === "staff")),
    coverageGaps,
    coverageSuggestions
  };

  if (user.role === "staff") {
    return {
      ...base,
      tasks: db.tasks,
      coverageRequests: db.coverageRequests.map(publicCoverageRequest),
      alerts: buildAlerts(coverageGaps),
      activity: db.activity,
      users: db.users.map(publicUser)
    };
  }

  const studentRequests = db.coverageRequests.filter((request) => request.workerId === user.workerId && coverageRequestInFocusWeek(request, db));
  return {
    ...base,
    tasks: db.tasks.filter((task) => task.assignedTo === user.workerId),
    coverageRequests: studentRequests.map(publicCoverageRequest),
    alerts: [...studentRequests.filter((request) => ["pending", "accepted"].includes(request.status)).map(requestToAlert), ...coverageGaps.slice(0, 6).map(gapToAlert)]
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    workerId: user.workerId || ""
  };
}

function publicWorker(worker, forStaff) {
  const weeklyHours = weeklyHoursFor(worker.availability, db.focusWeekStart);
  return {
    id: worker.id,
    name: worker.name,
    role: worker.role,
    initials: worker.initials,
    supervisor: forStaff ? worker.supervisor : "",
    primarySpaces: worker.primarySpaces,
    skills: worker.skills,
    availability: worker.availability,
    weeklyHours,
    weeklyLimit: WEEKLY_HOUR_LIMIT,
    remainingHours: Math.max(0, roundHours(WEEKLY_HOUR_LIMIT - weeklyHours)),
    overLimit: weeklyHours > WEEKLY_HOUR_LIMIT
  };
}

function publicEvent(event) {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    space: event.space,
    start: event.start,
    end: event.end,
    notes: event.notes || "",
    afterHours: Boolean(event.afterHours),
    status: event.status || "requesting",
    assignedTo: event.assignedTo || "",
    createdAt: event.createdAt || ""
  };
}

function publicCoverageRequest(request) {
  return {
    id: request.id,
    eventId: request.eventId,
    workerId: request.workerId,
    status: request.status,
    score: request.score || 0,
    reason: request.reason || "",
    createdAt: request.createdAt || "",
    respondedAt: request.respondedAt || ""
  };
}

function buildAlerts(gaps) {
  const gapAlerts = gaps.slice(0, 10).map(gapToAlert);
  const eventAlerts = db.events
    .filter((event) => event.afterHours && isDateInFocusWeek(event.date) && ["needs-review", "requesting", "accepted"].includes(event.status))
    .slice(0, 8)
    .map(eventToAlert);
  return [...eventAlerts, ...gapAlerts, ...(db.alerts || []).slice(0, 8)];
}

function gapToAlert(gap) {
  return {
    level: "warning",
    title: `${gap.space} has an uncovered time`,
    message: `${formatShortDate(gap.date)} from ${gap.detail}. ${gap.blocks.length ? `Other scheduled blocks that day: ${gap.blocks.join(", ")}.` : "No one is scheduled at that space that day."}`
  };
}

function eventToAlert(event) {
  const assigned = db.workers.find((worker) => worker.id === event.assignedTo)?.name;
  return {
    level: event.status === "needs-review" ? "warning" : "info",
    title: `${event.afterHours ? "After-hours" : "Event"} coverage: ${event.space}`,
    message: `${event.title} is ${formatShortDate(event.date)} ${formatTime(event.start)}-${formatTime(event.end)}. ${assigned ? `${assigned} has accepted; schedule update may still be needed.` : "Waiting on student response."}`
  };
}

function requestToAlert(request) {
  const event = db.events.find((item) => item.id === request.eventId);
  return {
    level: request.status === "pending" ? "warning" : "info",
    title: request.status === "pending" ? "Coverage request waiting" : "Coverage accepted",
    message: event ? `${event.title} at ${event.space}, ${formatShortDate(event.date)} ${formatTime(event.start)}-${formatTime(event.end)}.` : "Coverage request needs review."
  };
}

function coverageRequestInFocusWeek(request, appDb = db) {
  const event = appDb.events.find((item) => item.id === request.eventId);
  return Boolean(event && isDateInFocusWeek(event.date, appDb.focusWeekStart));
}

function createInitialDb() {
  const initial = {
    seedVersion: CURRENT_SEED_VERSION,
    focusDate: FALLBACK_FOCUS_DATE,
    focusWeekStart: SOURCE_WEEK_START,
    spaces: structuredClone(seedData.spaces),
    workers: structuredClone(seedData.workers),
    staffSchedules: structuredClone(seedData.staffSchedules),
    events: seedData.events.map(createScheduleEvent),
    coverageRequests: [],
    tasks: [],
    activity: [],
    alerts: [],
    airtable: {},
    users: []
  };

  initial.users.push(createSeedUser({
    id: "staff-admin",
    email: process.env.STAFF_EMAIL || "staff@ei.asu.edu",
    name: "E+I Staff Supervisor",
    role: "staff",
    password: process.env.STAFF_PASSWORD || "edson-staff"
  }));

  initial.workers.forEach((worker) => {
    initial.users.push(createSeedUser({
      id: `user-${worker.id}`,
      email: `${worker.id}@ei.asu.edu`,
      name: worker.name,
      role: "student",
      workerId: worker.id,
      password: process.env.STUDENT_DEFAULT_PASSWORD || "edson-student"
    }));
  });

  ensureCoverageRequestsForFocusWeek(initial);
  return initial;
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = createInitialDb();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return migrateDb(parsed);
}

function migrateDb(appDb) {
  if (appDb.seedVersion !== CURRENT_SEED_VERSION && process.env.PRESERVE_DEMO_DATA !== "true") {
    return createInitialDb();
  }
  appDb.seedVersion ||= CURRENT_SEED_VERSION;
  appDb.focusDate ||= FALLBACK_FOCUS_DATE;
  appDb.focusWeekStart ||= SOURCE_WEEK_START;
  appDb.activity ||= [];
  appDb.alerts ||= [];
  appDb.airtable ||= {};
  appDb.spaces ||= structuredClone(seedData.spaces);
  appDb.staffSchedules ||= structuredClone(seedData.staffSchedules);
  appDb.events ||= seedData.events.map(createScheduleEvent);
  appDb.coverageRequests ||= [];
  appDb.users ||= [];
  appDb.workers.forEach((worker) => {
    worker.skills = normalizeSkillList(worker.skills || []);
    worker.primarySpaces ||= [];
    worker.availability ||= [];
  });
  appDb.tasks.forEach((task) => {
    task.deniedBy ||= [];
    task.requiredSkills = normalizeSkillList(task.requiredSkills || []);
    if (!task.requiredSkills.length) task.requiredSkills = inferTaskSkills(task);
    task.priority ||= "Normal";
    task.status ||= "draft";
  });
  appDb.events = appDb.events.map((event) => normalizeScheduleEvent(event));
  appDb.coverageRequests.forEach((request) => {
    request.status ||= "pending";
    request.createdAt ||= new Date().toISOString();
    request.respondedAt ||= "";
    request.reason ||= "";
    request.score ||= 0;
  });
  if (!appDb.coverageRequests.length) {
    ensureCoverageRequestsForFocusWeek(appDb);
  }
  if (!appDb.users.length) {
    appDb.users = createInitialDb().users;
  }
  return appDb;
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function airtableConfigured() {
  return Boolean(process.env.AIRTABLE_PAT && process.env.AIRTABLE_BASE_ID);
}

function airtableStatus() {
  return {
    configured: airtableConfigured(),
    baseId: process.env.AIRTABLE_BASE_ID ? maskValue(process.env.AIRTABLE_BASE_ID) : "",
    tables: AIRTABLE_TABLES,
    missing: [
      process.env.AIRTABLE_PAT ? "" : "AIRTABLE_PAT",
      process.env.AIRTABLE_BASE_ID ? "" : "AIRTABLE_BASE_ID"
    ].filter(Boolean),
    lastSyncAt: db.airtable?.lastSyncAt || "",
    lastSyncSummary: db.airtable?.lastSyncSummary || null
  };
}

async function pushDbToAirtable() {
  const collections = {
    workers: db.workers.map(workerToAirtable),
    spaces: db.spaces.map(spaceToAirtable),
    tasks: db.tasks.map(taskToAirtable),
    schedules: db.workers.flatMap(workerSchedulesToAirtable)
  };
  const summary = { total: 0 };
  for (const [name, records] of Object.entries(collections)) {
    const result = await syncAirtableTable(AIRTABLE_TABLES[name], records);
    summary[name] = result;
    summary.total += result.created + result.updated;
  }
  return summary;
}

async function syncAirtableTable(tableName, rows) {
  const existing = await listAirtableRecords(tableName);
  const byExternalId = new Map(existing.map((record) => [record.fields?.["External ID"], record.id]).filter(([externalId]) => externalId));
  const creates = [];
  const updates = [];

  rows.forEach((fields) => {
    const recordId = byExternalId.get(fields["External ID"]);
    if (recordId) updates.push({ id: recordId, fields });
    else creates.push({ fields });
  });

  await writeAirtableBatches(tableName, "POST", creates);
  await writeAirtableBatches(tableName, "PATCH", updates);
  return { created: creates.length, updated: updates.length };
}

async function listAirtableRecords(tableName) {
  const records = [];
  let offset = "";
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (offset) params.set("offset", offset);
    const payload = await airtableRequest(tableName, `?${params.toString()}`);
    records.push(...(payload.records || []));
    offset = payload.offset || "";
  } while (offset);
  return records;
}

async function writeAirtableBatches(tableName, method, records) {
  for (const batch of chunk(records, 10)) {
    if (!batch.length) continue;
    await airtableRequest(tableName, "", { method, body: { records: batch } });
    await delay(240);
  }
}

async function airtableRequest(tableName, suffix = "", options = {}) {
  const encodedTable = encodeURIComponent(tableName);
  const url = `${AIRTABLE_API_URL}/${process.env.AIRTABLE_BASE_ID}/${encodedTable}${suffix}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload.error?.message || payload.error?.type || `Airtable request failed (${response.status})`;
    const error = new Error(message);
    error.status = 502;
    throw error;
  }
  return payload;
}

function workerToAirtable(worker) {
  const user = db.users.find((item) => item.workerId === worker.id);
  return {
    "External ID": worker.id,
    Name: worker.name,
    Initials: worker.initials,
    Role: worker.role,
    Supervisor: worker.supervisor,
    "Primary Spaces": worker.primarySpaces.join(", "),
    Skills: worker.skills.map(skillLabel).join(", "),
    Email: user?.email || ""
  };
}

function taskToAirtable(task) {
  return {
    "External ID": task.id,
    Title: task.title,
    Category: task.category,
    Group: task.group,
    Space: task.space,
    "Due Date": task.dueDate,
    Start: task.start,
    End: task.end,
    Priority: task.priority,
    "Assigned To": assignmentLabel(task),
    Status: task.status,
    "Required Skills": taskSkills(task).map(skillLabel).join(", "),
    Notes: task.notes,
    "AI Reason": task.aiReason,
    Confidence: task.confidence,
    Source: task.source
  };
}

function spaceToAirtable(space) {
  return {
    "External ID": space.id,
    Name: space.name,
    Campus: space.campus,
    "Business Hours": DAYS.filter((day) => space.hours[day])
      .map((day) => `${day}: ${formatTime(space.hours[day][0])}-${formatTime(space.hours[day][1])}`)
      .join("; ")
  };
}

function workerSchedulesToAirtable(worker) {
  return worker.availability.map((slotItem, index) => ({
    "External ID": `${worker.id}-${index}-${slotItem.day}-${slugify(slotItem.space)}`,
    Student: worker.name,
    Day: slotItem.day,
    Space: slotItem.space,
    Start: slotItem.start,
    End: slotItem.end,
    Source: slotItem.source || ""
  }));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskValue(value) {
  const clean = String(value || "");
  if (clean.length <= 8) return "configured";
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

function createScheduleEvent(input) {
  const event = normalizeScheduleEvent({
    id: input.id || `event-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    title: cleanText(input.title).slice(0, 160),
    date: normalizeDateValue(input.date || input.dueDate) || FALLBACK_FOCUS_DATE,
    space: normalizeSpaceName(input.space || "General"),
    start: normalizeTimeValue(input.start, "17:00"),
    end: normalizeTimeValue(input.end, "19:00"),
    notes: cleanText(input.notes),
    status: input.status || "requesting",
    assignedTo: input.assignedTo || "",
    createdAt: input.createdAt || new Date().toISOString()
  });
  if (minutes(event.end) <= minutes(event.start)) {
    const error = new Error("Invalid event time");
    error.status = 400;
    throw error;
  }
  return event;
}

function normalizeScheduleEvent(event) {
  const normalized = {
    id: event.id || `event-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    title: cleanText(event.title).slice(0, 160),
    date: normalizeDateValue(event.date || event.dueDate) || FALLBACK_FOCUS_DATE,
    space: normalizeSpaceName(event.space || "General"),
    start: normalizeTimeValue(event.start, "17:00"),
    end: normalizeTimeValue(event.end, "19:00"),
    notes: cleanText(event.notes),
    status: cleanText(event.status) || "requesting",
    assignedTo: cleanText(event.assignedTo),
    createdAt: event.createdAt || new Date().toISOString()
  };
  normalized.afterHours = isAfterHoursEvent(normalized);
  return normalized;
}

function createStaffSchedule(input) {
  const schedule = {
    id: input.id || `staff-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    name: cleanText(input.name).slice(0, 120) || "Staff member",
    day: cleanText(input.day),
    space: normalizeSpaceName(input.space || "General"),
    start: normalizeTimeValue(input.start, "09:00"),
    end: normalizeTimeValue(input.end, "17:00"),
    notes: cleanText(input.notes)
  };
  if (!DAYS.includes(schedule.day) || minutes(schedule.end) <= minutes(schedule.start)) {
    const error = new Error("Invalid staff schedule block");
    error.status = 400;
    throw error;
  }
  return schedule;
}

function createTask(input) {
  const task = {
    id: input.id || `task-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    title: cleanText(input.title).slice(0, 160),
    category: cleanText(input.category) || "Supervisor Task",
    group: cleanText(input.group),
    space: normalizeSpaceName(input.space || "General"),
    dueDate: normalizeDateValue(input.dueDate) || FALLBACK_FOCUS_DATE,
    start: normalizeTimeValue(input.start, "09:00"),
    end: normalizeTimeValue(input.end, "17:00"),
    priority: ["Normal", "High", "Urgent"].includes(input.priority) ? input.priority : "Normal",
    assignedTo: "",
    status: "draft",
    source: cleanText(input.source) || "Manual",
    sourceAssignee: cleanText(input.sourceAssignee),
    deniedBy: [],
    requiredSkills: normalizeSkillList(input.requiredSkills || []),
    notes: cleanText(input.notes),
    aiReason: "",
    confidence: 0
  };
  if (!task.requiredSkills.length) task.requiredSkills = inferTaskSkills(task);
  return task;
}

function normalizeTemplateTask(template, index, baseDate) {
  const task = createTask({
    id: `task-${template.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`,
    title: template.title,
    category: template.category,
    group: template.group || "",
    space: template.space || "WorldLabs Remote",
    dueDate: addDays(baseDate, template.dueOffset || 0),
    start: template.window?.[0] || "09:00",
    end: template.window?.[1] || "17:00",
    priority: template.priority || "Normal",
    source: template.source || `WorldLabs Calendar source date ${template.sourceDate}`,
    sourceAssignee: template.sourceAssignee || "",
    requiredSkills: template.requiredSkills || [],
    notes: template.notes || ""
  });
  return task;
}

function assignTask(task, appDb, options = {}) {
  const preferred = options.honorPreferred ? findWorkerBySourceName(task.sourceAssignee, appDb) : null;
  const preferredAllowed = preferred && !task.deniedBy.includes(preferred.id);
  const preferredScore = preferredAllowed ? scoreWorkerForTask(preferred, task, appDb) : null;
  const candidates = getCandidateScores(task, appDb);
  const best = candidates[0];

  if (preferredScore && preferredScore.score >= 50 && (!best || preferredScore.score >= best.score - 10)) {
    task.assignedTo = preferred.id;
    task.status = "pending";
    task.confidence = Math.min(98, Math.max(55, Math.round(preferredScore.score)));
    task.aiReason = `Matched original calendar assignee and ${preferredScore.reason.toLowerCase()}`;
    return;
  }

  if (!best || best.score < 35) {
    task.assignedTo = "";
    task.status = "unassigned";
    task.confidence = best ? Math.round(best.score) : 0;
    task.aiReason = best ? `Best match was ${best.worker.name}, but the score was low. Staff should review.` : "No student availability matched the task window.";
    return;
  }

  task.assignedTo = best.worker.id;
  task.status = "pending";
  task.confidence = Math.min(98, Math.max(45, Math.round(best.score)));
  task.aiReason = best.reason;
}

function getCandidateScores(task, appDb, options = {}) {
  return appDb.workers
    .map((worker) => scoreWorkerForTask(worker, task, appDb))
    .filter((score) => options.includeUnavailable || score.score >= 1)
    .sort((a, b) => b.score - a.score || a.worker.name.localeCompare(b.worker.name));
}

function scoreWorkerForTask(worker, task, appDb) {
  if (task.deniedBy?.includes(worker.id)) {
    return { worker, score: 0, reason: "Previously denied this task." };
  }

  const day = dayFromDate(task.dueDate);
  const shiftMatches = worker.availability.filter((item) => item.day === day);
  const taskStart = minutes(task.start);
  const taskEnd = minutes(task.end);
  let bestOverlap = 0;
  let sameSpace = false;

  shiftMatches.forEach((shiftItem) => {
    const overlapMinutes = overlap(taskStart, taskEnd, minutes(shiftItem.start), minutes(shiftItem.end));
    bestOverlap = Math.max(bestOverlap, overlapMinutes);
    if (shiftItem.space === task.space) sameSpace = true;
  });

  let score = 0;
  const reasons = [];

  if (bestOverlap > 0) {
    score += 60 + Math.min(20, bestOverlap / 15);
    reasons.push(`${Math.round((bestOverlap / 60) * 10) / 10}h available`);
  } else if (shiftMatches.length && ["WorldLabs Post", "Data Pull", "Supervisor Task"].includes(task.category)) {
    score += 22;
    reasons.push("available that day");
  } else if (shiftMatches.length) {
    score += 8;
    reasons.push("scheduled that day but outside the task time");
  }

  if (sameSpace) {
    score += 25;
    reasons.push(`already at ${task.space}`);
  }

  if (worker.primarySpaces.includes(task.space)) {
    score += 15;
    reasons.push("primary space match");
  }

  const requiredSkills = taskSkills(task);
  const matchingSkills = requiredSkills.filter((skill) => worker.skills.includes(skill));
  if (matchingSkills.length) {
    score += Math.min(42, matchingSkills.length * 18);
    reasons.push(`${matchingSkills.map(skillLabel).join(", ")} skill`);
  } else if (requiredSkills.length) {
    score -= 12;
    reasons.push(`missing ${requiredSkills.map(skillLabel).join(", ")}`);
  }

  if (sourceNameMatches(worker, task.sourceAssignee)) {
    score += 10;
    reasons.push("calendar assignee match");
  }

  const activeLoad = appDb.tasks.filter((item) => item.assignedTo === worker.id && ["pending", "accepted"].includes(item.status)).length;
  score += Math.max(0, 12 - activeLoad * 3);

  if (task.priority === "Urgent" && bestOverlap === 0) score -= 16;
  if (["Event Coverage", "On-site Coverage"].includes(task.category) && !sameSpace) score -= 8;

  return {
    worker,
    score: Math.max(0, score),
    reason: reasons.length ? reasons.join(", ") : "No matching schedule or skill."
  };
}

function createCoverageRequestsForEvent(event, appDb, options = {}) {
  const candidates = recommendWorkersForEvent(event, appDb).slice(0, 1);
  const created = [];

  candidates.forEach((candidate) => {
    const exists = appDb.coverageRequests.some((request) => request.eventId === event.id && request.workerId === candidate.worker.id);
    if (exists) return;
    appDb.coverageRequests.push({
      id: `request-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      eventId: event.id,
      workerId: candidate.worker.id,
      status: "pending",
      score: Math.min(100, Math.round(candidate.score)),
      reason: candidate.reason,
      createdAt: new Date().toISOString(),
      respondedAt: ""
    });
    created.push(candidate.worker);
  });

  if (!created.length) {
    event.status = event.assignedTo ? event.status : "needs-review";
    if (!options.silent) {
      pushAlert(appDb, "warning", "Event needs supervisor review", `${event.title} at ${event.space} did not have a strong student-worker match.`);
    }
    return created;
  }

  if (!event.assignedTo) event.status = "requesting";
  if (!options.silent) {
    pushAlert(appDb, "info", "Coverage requests sent", `${event.title}: asked ${created.map((worker) => worker.name).join(", ")} about coverage.`);
  }
  return created;
}

function ensureCoverageRequestsForFocusWeek(appDb) {
  appDb.events
    .filter((event) => event.afterHours && event.status !== "scheduled" && isDateInFocusWeek(event.date, appDb.focusWeekStart))
    .forEach((event) => createCoverageRequestsForEvent(event, appDb, { silent: true }));
}

function recommendWorkersForEvent(event, appDb) {
  const owner = spaceOwnerForEvent(event, appDb);
  if (owner) return [scoreWorkerForScheduleNeed(owner, event, appDb)];
  return appDb.workers
    .map((worker) => scoreWorkerForScheduleNeed(worker, event, appDb))
    .filter((candidate) => candidate.score >= 20)
    .sort((a, b) => b.score - a.score || a.worker.name.localeCompare(b.worker.name));
}

function spaceOwnerForEvent(event, appDb) {
  const ownerId = SPACE_OWNER_WORKER_IDS[event.space];
  if (ownerId) {
    const owner = appDb.workers.find((worker) => worker.id === ownerId);
    if (owner) return owner;
  }
  return appDb.workers.find((worker) => worker.primarySpaces.includes(event.space));
}

function getCoverageSuggestions(gaps) {
  return gaps.slice(0, 20).map((gap) => ({
    ...gap,
    candidates: recommendWorkersForScheduleNeedForGap(gap, db).slice(0, 3).map((candidate) => ({
      workerId: candidate.worker.id,
      name: candidate.worker.name,
      score: Math.min(100, Math.round(candidate.score)),
      reason: candidate.reason
    }))
  }));
}

function recommendWorkersForScheduleNeedForGap(gap, appDb) {
  return appDb.workers
    .map((worker) => scoreWorkerForScheduleNeed(worker, {
      title: `${gap.space} coverage gap`,
      date: gap.date,
      space: gap.space,
      start: gap.start,
      end: gap.end,
      afterHours: false
    }, appDb))
    .filter((candidate) => candidate.score >= 18)
    .sort((a, b) => b.score - a.score || a.worker.name.localeCompare(b.worker.name));
}

function scoreWorkerForScheduleNeed(worker, need, appDb) {
  const day = dayFromDate(need.date);
  const needStart = minutes(need.start);
  const needEnd = minutes(need.end);
  const shifts = worker.availability.filter((item) => scheduleItemMatchesDate(item, day, need.date));
  const sameSpaceShifts = shifts.filter((item) => item.space === need.space);
  const bestOverlap = shifts.reduce((best, item) => Math.max(best, overlap(needStart, needEnd, minutes(item.start), minutes(item.end))), 0);
  const closeShift = sameSpaceShifts.find((item) => Math.abs(minutes(item.end) - needStart) <= 180 || Math.abs(minutes(item.start) - needEnd) <= 180);
  const requestLoad = appDb.coverageRequests.filter((request) => request.workerId === worker.id && ["pending", "accepted"].includes(request.status)).length;
  let score = 0;
  const reasons = [];

  if (worker.primarySpaces.includes(need.space)) {
    score += 34;
    reasons.push("primary space");
  }
  if (sameSpaceShifts.length) {
    score += 26;
    reasons.push("already works that space");
  }
  if (bestOverlap > 0) {
    score += 28 + Math.min(18, bestOverlap / 20);
    reasons.push(`${Math.round((bestOverlap / 60) * 10) / 10}h overlap`);
  } else if (closeShift) {
    score += 18;
    reasons.push("shift is near that time");
  } else if (shifts.length) {
    score += 8;
    reasons.push("works that day");
  }
  if (worker.skills.includes("events")) {
    score += 16;
    reasons.push("event coverage skill");
  }
  if (worker.skills.includes("coverage") || worker.skills.includes("customer-service")) {
    score += 12;
    reasons.push("coverage/front desk skill");
  }
  if (need.afterHours && worker.primarySpaces.includes(need.space)) {
    score += 12;
    reasons.push("after-hours space owner");
  }
  score += Math.max(0, 10 - requestLoad * 3);

  return {
    worker,
    score: Math.max(0, score),
    reason: reasons.length ? reasons.join(", ") : "No strong schedule match"
  };
}

function getCoverageGaps() {
  const gaps = [];
  db.spaces
    .filter((space) => space.name !== "WorldLabs Remote")
    .forEach((space) => {
      DAYS.forEach((day, dayIndex) => {
        const hours = space.hours[day];
        if (!hours) return;
        const date = addDays(db.focusWeekStart, dayIndex);
        if (isClosedDate(space, date)) return;
        const open = minutes(hours[0]);
        const close = minutes(hours[1]);
        const studentBlocks = db.workers.flatMap((worker) =>
          worker.availability
            .filter((slotItem) => scheduleItemMatchesDate(slotItem, day, date) && slotItem.space === space.name)
            .map((slotItem) => ({
              start: minutes(slotItem.start),
              end: minutes(slotItem.end),
              label: `${worker.name} ${formatTime(slotItem.start)}-${formatTime(slotItem.end)}`
            }))
        );
        const staffBlocks = (db.staffSchedules || [])
          .filter((slotItem) => scheduleItemMatchesDate(slotItem, day, date) && slotItem.space === space.name)
          .map((slotItem) => ({
            start: minutes(slotItem.start),
            end: minutes(slotItem.end),
            label: `${slotItem.name} ${formatTime(slotItem.start)}-${formatTime(slotItem.end)}`
          }));
        const allBlocks = [...studentBlocks, ...staffBlocks];
        const intervals = allBlocks
          .map((block) => ({
            start: Math.max(open, block.start),
            end: Math.min(close, block.end),
            label: block.label
          }))
          .filter((block) => block.end > block.start)
          .sort((a, b) => a.start - b.start);

        if (!intervals.length) {
          gaps.push({
            space: space.name,
            date,
            start: hours[0],
            end: hours[1],
            detail: `${formatTime(hours[0])}-${formatTime(hours[1])}`,
            level: "No coverage",
            blocks: allBlocks.map((block) => block.label)
          });
          return;
        }

        let cursor = open;
        intervals.forEach((interval) => {
          if (interval.start > cursor) {
            gaps.push({
              space: space.name,
              date,
              start: timeFromMinutes(cursor),
              end: timeFromMinutes(interval.start),
              detail: `${formatTimeFromMinutes(cursor)}-${formatTimeFromMinutes(interval.start)}`,
              level: "Coverage gap",
              blocks: allBlocks.map((block) => block.label)
            });
          }
          cursor = Math.max(cursor, interval.end);
        });
        if (cursor < close) {
          gaps.push({
            space: space.name,
            date,
            start: timeFromMinutes(cursor),
            end: hours[1],
            detail: `${formatTimeFromMinutes(cursor)}-${formatTime(hours[1])}`,
            level: "Coverage gap",
            blocks: allBlocks.map((block) => block.label)
          });
        }
      });
    });
  return gaps;
}

function applyScheduleChange(worker, change) {
  const day = cleanText(change.day);
  const space = normalizeSpaceName(change.space);
  const start = normalizeTimeValue(change.start, "09:00");
  const end = normalizeTimeValue(change.end, "17:00");
  const mode = cleanText(change.mode) || "add";
  const slotIndex = Number(change.slotIndex);
  const date = normalizeDateValue(change.date) || (DAYS.includes(day) ? addDays(db.focusWeekStart, DAYS.indexOf(day)) : "");

  if (!DAYS.includes(day) || minutes(end) <= minutes(start)) {
    throw new Error("Invalid schedule block");
  }

  const before = worker.availability.length;
  const weekStart = date ? weekStartMonday(date) : db.focusWeekStart;
  const beforeHours = weeklyHoursFor(worker.availability, weekStart);
  let nextAvailability = [...worker.availability];
  if (mode === "replace-day") {
    nextAvailability = nextAvailability.filter((item) => !scheduleItemMatchesDate(item, day, date));
  }
  if (mode === "replace-space") {
    nextAvailability = nextAvailability.filter((item) => !(scheduleItemMatchesDate(item, day, date) && item.space === space));
  }
  if (mode === "edit-slot") {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= nextAvailability.length) {
      const error = new Error("Choose a schedule block to edit");
      error.status = 400;
      throw error;
    }
    nextAvailability = nextAvailability.filter((_, index) => index !== slotIndex);
  }
  nextAvailability.push(slot(day, space, start, end, change.source, date));
  nextAvailability.sort(sortScheduleSlots);

  const nextHours = weeklyHoursFor(nextAvailability, weekStart);
  if (nextHours > WEEKLY_HOUR_LIMIT) {
    const error = new Error(`${worker.name} would be scheduled for ${formatHourTotal(nextHours)} hours this week. Student workers must stay at or under ${WEEKLY_HOUR_LIMIT} hours, so edit or remove another block first.`);
    error.status = 400;
    throw error;
  }

  worker.availability = nextAvailability;

  const modeLabel = mode === "add" ? "added" : mode === "edit-slot" ? "edited" : "changed";
  addAlert("warning", "Schedule changed", `${worker.name} ${modeLabel} ${space} on ${day}, ${formatTime(start)}-${formatTime(end)}. Weekly total: ${formatHourTotal(nextHours)}/${WEEKLY_HOUR_LIMIT} hours.`);
  addActivity(`${worker.name} ${modeLabel} schedule at ${space}; ${before} block${before === 1 ? "" : "s"} became ${worker.availability.length}, ${formatHourTotal(beforeHours)}h became ${formatHourTotal(nextHours)}h.`);
}

function weeklyHoursFor(availability, weekStart = db?.focusWeekStart || SOURCE_WEEK_START) {
  const hours = (availability || [])
    .filter((item) => scheduleItemInWeek(item, weekStart))
    .reduce((total, item) => total + paidHoursForScheduleItem(item), 0);
  return roundHours(hours);
}

function paidHoursForScheduleItem(item) {
  const hours = Math.max(0, minutes(item.end) - minutes(item.start)) / 60;
  return hours >= 8.5 ? hours - 1 : hours;
}

function scheduleItemInWeek(item, weekStart = db?.focusWeekStart || SOURCE_WEEK_START) {
  if (!item.date) return true;
  return isDateInFocusWeek(item.date, weekStart);
}

function scheduleItemMatchesDate(item, day, date) {
  if (item.day !== day) return false;
  return !item.date || item.date === date;
}

function sortScheduleSlots(a, b) {
  return (a.date || "").localeCompare(b.date || "") || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || minutes(a.start) - minutes(b.start) || a.space.localeCompare(b.space);
}

function roundHours(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatHourTotal(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function addAlert(level, title, message) {
  pushAlert(db, level, title, message);
}

function pushAlert(appDb, level, title, message) {
  appDb.alerts ||= [];
  appDb.alerts.unshift({
    id: `alert-${Date.now()}-${appDb.alerts.length}`,
    level,
    title,
    message,
    at: new Date().toISOString()
  });
  appDb.alerts = appDb.alerts.slice(0, 25);
}

function addActivity(message) {
  db.activity ||= [];
  db.activity.unshift({ message, at: new Date().toISOString() });
  db.activity = db.activity.slice(0, 50);
}

function createSeedUser(input) {
  return {
    id: input.id,
    email: input.email,
    name: input.name,
    role: input.role,
    workerId: input.workerId || "",
    password: hashPassword(input.password)
  };
}

function createOrUpdateUser(input) {
  const role = cleanText(input.role) === "staff" ? "staff" : "student";
  const email = cleanText(input.email).toLowerCase();
  const password = cleanText(input.password);
  if (!email || !email.includes("@")) {
    const error = new Error("A valid email is required.");
    error.status = 400;
    throw error;
  }
  if (password.length < 8) {
    const error = new Error("Use a temporary password with at least 8 characters.");
    error.status = 400;
    throw error;
  }

  if (role === "student") {
    const workerId = cleanText(input.workerId);
    const worker = db.workers.find((item) => item.id === workerId);
    if (!worker) {
      const error = new Error("Choose a student profile for student logins.");
      error.status = 400;
      throw error;
    }
    const existingForWorker = db.users.find((item) => item.workerId === worker.id);
    const emailOwner = db.users.find((item) => item.email.toLowerCase() === email && item.id !== existingForWorker?.id);
    if (emailOwner) {
      const error = new Error("That email already has a login.");
      error.status = 400;
      throw error;
    }
    if (existingForWorker) {
      existingForWorker.email = email;
      existingForWorker.name = worker.name;
      existingForWorker.role = "student";
      existingForWorker.workerId = worker.id;
      existingForWorker.password = hashPassword(password);
      return { user: existingForWorker, action: "Updated", created: false };
    }
    const newUser = createSeedUser({
      id: `user-${worker.id}`,
      email,
      name: worker.name,
      role: "student",
      workerId: worker.id,
      password
    });
    db.users.push(newUser);
    return { user: newUser, action: "Created", created: true };
  }

  if (db.users.some((item) => item.email.toLowerCase() === email)) {
    const error = new Error("That email already has a login.");
    error.status = 400;
    throw error;
  }
  const name = cleanText(input.name) || email.split("@")[0];
  const newUser = createSeedUser({
    id: `staff-${slugify(name)}-${Date.now()}`,
    email,
    name,
    role: "staff",
    password
  });
  db.users.push(newUser);
  return { user: newUser, action: "Created", created: true };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function getUserFromRequest(req) {
  const token = getCookie(req, COOKIE_NAME);
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return db.users.find((user) => user.id === session.userId) || null;
}

function requireStaff(user) {
  if (!user || user.role !== "staff") {
    const error = new Error("Staff access required");
    error.status = 403;
    throw error;
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const allowed = new Set(["/index.html", "/styles.css", "/app.js"]);
  if (!allowed.has(safePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const filePath = path.join(__dirname, safePath);
  const ext = path.extname(filePath);
  const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" }[ext] || "text/plain";
  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function slot(day, space, start, end, source = "PBIS Schedule", date = "") {
  const item = { day, space, start, end, source };
  if (date) item.date = date;
  return item;
}

function parseEventList(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseEventLine)
    .filter(Boolean);
}

function parseEventLine(line) {
  const parts = line.includes("|") ? line.split("|") : line.split(/\t|,/);
  if (parts.length < 5) return null;
  const [title, date, space, start, end, skillText] = parts.map(cleanText);
  const dueDate = normalizeDateValue(date);
  if (!title || !dueDate) return null;
  const requiredSkills = normalizeSkillList(splitSkillInput(skillText || "Event Coverage, Front Desk"));
  return {
    title,
    dueDate,
    space: normalizeSpaceName(space),
    start: normalizeTimeValue(start, "09:00"),
    end: normalizeTimeValue(end, "17:00"),
    requiredSkills: requiredSkills.length ? requiredSkills : ["events", "customer-service"]
  };
}

function taskSkills(task) {
  const skills = normalizeSkillList(task.requiredSkills || []);
  return skills.length ? skills : inferTaskSkills(task);
}

function inferTaskSkills(task) {
  const skills = new Set();
  if (CATEGORY_SKILLS[task.category]) skills.add(CATEGORY_SKILLS[task.category]);
  const text = `${task.title || ""} ${task.category || ""} ${task.notes || ""}`.toLowerCase();
  if (text.includes("graphic") || text.includes("design") || text.includes("flyer") || text.includes("social")) skills.add("graphic-design");
  if (text.includes("admin") || text.includes("inventory") || text.includes("email")) skills.add("administrative");
  if (text.includes("post") || text.includes("message") || text.includes("reply")) skills.add("communications");
  if (task.category === "Event Coverage") {
    skills.add("events");
    skills.add("customer-service");
  }
  if (task.category === "On-site Coverage") {
    skills.add("coverage");
    skills.add("customer-service");
  }
  if (task.category === "Data Pull") {
    skills.add("data");
    skills.add("administrative");
  }
  return [...skills];
}

function normalizeSkillList(skills) {
  return [...new Set((skills || []).map(normalizeSkillName).filter(Boolean))];
}

function splitSkillInput(value) {
  return String(value || "").split(/[,;\n]+/).map(cleanText).filter(Boolean);
}

function normalizeSkillName(value) {
  const clean = cleanText(value).toLowerCase();
  if (!clean) return "";
  const match = SKILL_OPTIONS.find((skill) => skill.id === clean || skill.label.toLowerCase() === clean);
  if (match) return match.id;
  if (["graphic designing", "graphics", "designing"].includes(clean)) return "graphic-design";
  if (["admin", "administration"].includes(clean)) return "administrative";
  if (["front desk", "front-desk", "customer service"].includes(clean)) return "customer-service";
  if (["event", "event coverage", "events coverage"].includes(clean)) return "events";
  if (["space coverage", "onsite", "on site"].includes(clean)) return "coverage";
  if (["reporting", "data reporting", "data/reporting"].includes(clean)) return "data";
  return slugify(clean);
}

function skillLabel(skill) {
  return SKILL_LABELS[skill] || titleCase(skill.replace(/-/g, " "));
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (char) => char.toUpperCase());
}

function findWorkerBySourceName(sourceName, appDb) {
  if (!sourceName) return null;
  return appDb.workers.find((worker) => sourceNameMatches(worker, sourceName));
}

function sourceNameMatches(worker, sourceName) {
  if (!sourceName) return false;
  const source = sourceName.toLowerCase().trim();
  const names = worker.name.toLowerCase().split(/\s+/);
  return names.includes(source) || worker.name.toLowerCase().includes(source);
}

function assignmentLabel(task) {
  return db.workers.find((worker) => worker.id === task.assignedTo)?.name || "Staff review";
}

function normalizeDateValue(value) {
  const clean = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const match = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
  }
  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function normalizeTimeValue(value, fallback) {
  const clean = cleanText(value).toLowerCase().replace(/\s+/g, "");
  if (/^\d{1,2}:\d{2}$/.test(clean)) {
    const [hour, minute] = clean.split(":");
    return `${String(Number(hour)).padStart(2, "0")}:${minute}`;
  }
  const match = clean.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (!match) return fallback;
  let hour = Number(match[1]);
  const minute = match[2] || "00";
  if (match[3] === "pm" && hour < 12) hour += 12;
  if (match[3] === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function normalizeSpaceName(value) {
  const clean = cleanText(value);
  const lowered = clean.toLowerCase();
  if (["1951", "1951.0", "1951@skysong", "1951 @ skysong"].includes(lowered)) return "1951@SkySong";
  if (["skysong", "sky song"].includes(lowered)) return "SkySong";
  if (lowered === "850pbc") return "850PBC";
  if (lowered === "acic") return "ACIC";
  if (["mesa", "the studios", "studios", "studios @ mesa", "the studios @ mesa"].includes(lowered)) return "The Studios";
  const exact = db?.spaces?.find((space) => space.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.name;
  const source = db?.spaces || seedData.spaces;
  const partial = source.find((space) => space.name.toLowerCase().includes(clean.toLowerCase()) || clean.toLowerCase().includes(space.name.toLowerCase()));
  return partial?.name || clean || "General";
}

function sortTasks(a, b) {
  return a.dueDate.localeCompare(b.dueDate) || minutes(a.start) - minutes(b.start) || priorityRank(b.priority) - priorityRank(a.priority);
}

function priorityRank(priority) {
  return { Urgent: 3, High: 2, Normal: 1 }[priority] || 0;
}

function dayFromDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return date.toLocaleDateString("en-US", { weekday: "long" });
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

function isDateInFocusWeek(dateString, weekStart = db?.focusWeekStart || SOURCE_WEEK_START) {
  return dateString >= weekStart && dateString <= addDays(weekStart, 6);
}

function isClosedDate(space, dateString) {
  return Array.isArray(space?.closedDates) && space.closedDates.includes(dateString);
}

function minutes(time) {
  const [hours, mins] = String(time || "00:00").split(":").map(Number);
  return hours * 60 + mins;
}

function overlap(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function isAfterHoursEvent(event) {
  const space = (db?.spaces || seedData.spaces).find((item) => item.name === event.space);
  if (isClosedDate(space, event.date)) return true;
  const hours = space?.hours?.[dayFromDate(event.date)];
  if (!hours) return true;
  return minutes(event.start) < minutes(hours[0]) || minutes(event.end) > minutes(hours[1]);
}

function timeFromMinutes(total) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatTime(time) {
  if (!time) return "";
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const normalHour = hour % 12 || 12;
  return `${normalHour}:${String(minute).padStart(2, "0")}${suffix}`;
}

function formatTimeFromMinutes(total) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return formatTime(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

function formatShortDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function cleanText(value) {
  return String(value || "").trim();
}

function slugify(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `item-${Date.now()}`;
}

function initialsFromName(name) {
  return cleanText(name)
    .split(/\s+/)
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

const sourceTaskTemplates = [
  { title: "Prompt: Share something new you learned this week.", category: "WorldLabs Post", sourceDate: "2025-10-01", sourceAssignee: "Aarav", group: "General E+I", dueOffset: 0, window: ["10:00", "16:00"], priority: "Normal" },
  { title: "Save the Date: Pitch In is next week", category: "WorldLabs Post", sourceDate: "2025-10-01", sourceAssignee: "", group: "Pitch In", dueOffset: 0, window: ["10:00", "16:00"], priority: "High" },
  { title: "Save the Date: Coffee + Co-Working", category: "WorldLabs Post", sourceDate: "2025-10-01", sourceAssignee: "", group: "General E+I", dueOffset: 1, window: ["10:00", "16:00"], priority: "Normal" },
  { title: "Launch: Monthly Bingo Card", category: "WorldLabs Post", sourceDate: "2025-10-02", sourceAssignee: "", group: "General E+I", dueOffset: 2, window: ["09:00", "14:00"], priority: "Normal", requiredSkills: ["graphic-design", "communications"] },
  { title: "Prompt: Celebrate a tiny win with us today.", category: "WorldLabs Post", sourceDate: "2025-10-03", sourceAssignee: "Aarav", group: "Chandler Endeavor", dueOffset: 0, window: ["11:00", "16:00"], priority: "Normal" },
  { title: "Chandler Endeavor weekly WorldLabs post", category: "WorldLabs Post", sourceDate: "2025-10-07", sourceAssignee: "Deepinderjit", group: "Chandler Endeavor", dueOffset: 4, window: ["09:00", "13:00"], priority: "Normal" },
  { title: "Reminder: Pitch In tomorrow", category: "WorldLabs Post", sourceDate: "2025-10-07", sourceAssignee: "Srusti", group: "Pitch In", dueOffset: 3, window: ["09:00", "13:00"], priority: "High" },
  { title: "Join now: Coffee + Co-Working happening today", category: "WorldLabs Post", sourceDate: "2025-10-08", sourceAssignee: "Aarav", group: "General E+I", dueOffset: 5, window: ["08:00", "11:00"], priority: "High" },
  { title: "Pull CE and PBIS registration and attendee data", category: "Data Pull", sourceDate: "2025-10-01", sourceAssignee: "", group: "Chandler Endeavor, PBIS", dueOffset: 0, window: ["13:00", "17:00"], priority: "High" },
  { title: "Pull new member data from WorldLabs groups", category: "Data Pull", sourceDate: "2025-10-02", sourceAssignee: "", group: "Chandler Endeavor, Goodyear, Pitch In", dueOffset: 2, window: ["12:00", "16:00"], priority: "Normal" },
  { title: "Check Prototyping Studio applications and alert Lynn", category: "Data Pull", sourceDate: "2025-10-17", sourceAssignee: "", group: "Prototyping Studio", dueOffset: 4, window: ["09:00", "17:00"], priority: "Normal" }
];

const coverageTaskTemplates = [
  { title: "1951 front desk and visitor coverage", category: "On-site Coverage", space: "1951@SkySong", dueOffset: 0, window: ["09:00", "17:00"], priority: "High", source: "Staff and Space Schedule" },
  { title: "850PBC student coverage", category: "On-site Coverage", space: "850PBC", dueOffset: 0, window: ["08:00", "17:00"], priority: "High", source: "Staff and Space Schedule" },
  { title: "ACIC morning coverage", category: "On-site Coverage", space: "ACIC", dueOffset: 0, window: ["08:00", "13:00"], priority: "Normal", source: "Staff and Space Schedule" },
  { title: "The Studios weekday coverage", category: "On-site Coverage", space: "The Studios", dueOffset: 0, window: ["08:00", "17:00"], priority: "Normal", source: "Staff and Space Schedule" },
  { title: "ASU event coverage at 1951", category: "Event Coverage", space: "1951@SkySong", dueOffset: 0, window: ["17:00", "19:30"], priority: "Urgent", source: "After Hour Events" },
  { title: "The Studios weekend coverage", category: "On-site Coverage", space: "The Studios", dueOffset: 1, window: ["08:30", "16:30"], priority: "High", source: "Staff and Space Schedule" },
  { title: "ASU late event coverage at 1951", category: "Event Coverage", space: "1951@SkySong", dueOffset: 1, window: ["20:30", "23:30"], priority: "Urgent", source: "After Hour Events" },
  { title: "ACIC afternoon coverage", category: "On-site Coverage", space: "ACIC", dueOffset: 0, window: ["13:00", "17:00"], priority: "Normal", source: "Staff and Space Schedule" }
];

db = loadDb();

server.listen(PORT, () => {
  console.log(`Edson E+I Schedule Manager running at http://localhost:${PORT}`);
  if (!process.env.STAFF_PASSWORD || !process.env.STUDENT_DEFAULT_PASSWORD) {
    console.log("Default seed passwords are active. Set STAFF_PASSWORD and STUDENT_DEFAULT_PASSWORD before real deployment.");
  }
});

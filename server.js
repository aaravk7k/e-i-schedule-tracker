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
  spaces: process.env.AIRTABLE_TABLE_SPACES || "Spaces",
  state: process.env.AIRTABLE_TABLE_STATE || "Schedule Manager State"
};
const AIRTABLE_BACKEND_ENABLED = ["1", "true", "yes", "airtable"].includes(String(process.env.AIRTABLE_BACKEND || process.env.STORAGE_BACKEND || "").toLowerCase());
const AIRTABLE_STATE_KEY = process.env.AIRTABLE_STATE_KEY || "schedule-manager-state";
const AIRTABLE_STATE_CHUNK_SIZE = Number(process.env.AIRTABLE_STATE_CHUNK_SIZE || 45000);
const MAZEVO_BASE_URL = String(process.env.MAZEVO_BASE_URL || "").replace(/\/+$/, "");
const MAZEVO_API_KEY = process.env.MAZEVO_API_KEY || "";
const MAZEVO_EVENTS_ENDPOINT = process.env.MAZEVO_EVENTS_ENDPOINT || "PublicEvent/getevents";
const MAZEVO_EVENTS_METHOD = String(process.env.MAZEVO_EVENTS_METHOD || "POST").toUpperCase();
const MAZEVO_AUTH_HEADER = process.env.MAZEVO_AUTH_HEADER || "X-API-Key";
const MAZEVO_AUTH_PREFIX = Object.prototype.hasOwnProperty.call(process.env, "MAZEVO_AUTH_PREFIX") ? process.env.MAZEVO_AUTH_PREFIX : "";
const MAZEVO_API_KEY_QUERY_PARAM = process.env.MAZEVO_API_KEY_QUERY_PARAM || "";
const MAZEVO_LOOKAHEAD_DAYS = Number(process.env.MAZEVO_LOOKAHEAD_DAYS || 60);
const MAZEVO_CONFIRMED_STATUSES = String(process.env.MAZEVO_CONFIRMED_STATUSES || "confirmed")
  .split(",")
  .map((status) => status.trim().toLowerCase())
  .filter(Boolean);
const MAZEVO_SYNC_SECRET = process.env.MAZEVO_SYNC_SECRET || "";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SOURCE_WEEK_START = "2026-05-25";
const FALLBACK_FOCUS_DATE = "2026-05-27";
const CURRENT_SEED_VERSION = "pbis-summer-2026-june-bookings-0604";
const WEEKLY_HOUR_LIMIT = Number(process.env.STUDENT_WEEKLY_HOUR_LIMIT || 40);
const DEFAULT_LONG_SHIFT_BREAK_MINUTES = 60;
const LONG_SHIFT_BREAK_THRESHOLD_MINUTES = 9 * 60;
const NO_UNPAID_BREAK_OVERRIDE_MINUTES = 10 * 60;

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
  "WorldLabs Remote": "#344054",
  "General": "#667085"
};

const REMOVED_SPACES = new Set(["fusion on first"]);

const SPACE_OWNER_WORKER_IDS = {
  "1951@SkySong": "amanda",
  "850PBC": ["palash", "sakshi"],
  ACIC: "deepinderjit-singh",
  "The Studios": "shreyas",
  SkySong: "aarav-kapoor"
};

const SAKSHI_WORKER_ID = "sakshi";
const SAKSHI_START_DATE = "2026-06-15";
const SAKSHI_DEFAULT_SCHEDULE_SOURCE = "Staff-provided Sakshi schedule";
const SCHEDULE_OVERRIDE_SOURCES = new Set(["Staff schedule edit", "Student schedule change"]);
const OBSERVED_CLOSED_DATES = ["2026-07-03"];
const NO_UNPAID_BREAK_OVERRIDES = [
  { workerId: "aarav-kapoor", startDate: "2026-06-29", endDate: "2026-07-02" },
  { workerId: "amanda", startDate: "2026-06-29", endDate: "2026-07-02" }
];
const STAFF_STATUS_PEOPLE = [
  "Matthew Kohlbeck",
  "Paula Alvarado",
  "Lynn Romero",
  "Dania Alcala-Calvillo"
];
const STAFF_STATUS_OPTIONS = ["In Office", "Remote", "Out of Office"];
const STAFF_STATUS_DEFAULT = "Not Set";

const sessions = new Map();
let db;
let airtableStateSaveChain = Promise.resolve();
let airtableStateActive = false;

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

  if (req.method === "POST" && url.pathname === "/api/mazevo/sync" && !user) {
    if (!mazevoSyncSecretAllowed(req)) {
      sendJson(res, 401, { error: "Mazevo sync secret is missing or invalid" });
      return;
    }
    const body = await readJson(req);
    const summary = await syncMazevoEvents(body);
    saveDb();
    sendJson(res, 200, { ok: true, summary });
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

  if (req.method === "POST" && url.pathname === "/api/staff-statuses") {
    requireStaff(user);
    const body = await readJson(req);
    const status = upsertStaffStatus(body, user);
    addActivity(`${user.name} set ${status.name} as ${status.status}${status.space ? ` at ${status.space}` : ""} for ${formatShortDate(status.date)}.`);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/airtable/status") {
    requireStaff(user);
    sendJson(res, 200, airtableStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/mazevo/status") {
    requireStaff(user);
    sendJson(res, 200, mazevoStatus());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mazevo/sync") {
    requireStaff(user);
    const body = await readJson(req);
    const summary = await syncMazevoEvents(body);
    saveDb();
    sendJson(res, 200, viewForUser(user));
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
    if (user.role !== "staff") {
      const request = createScheduleChangeRequest(worker, body, user, "change");
      saveDb();
      sendJson(res, 202, viewForUser(user));
      return;
    }
    applyScheduleChange(worker, {
      day: body.day,
      space: body.space,
      start: body.start,
      end: body.end,
      mode: body.mode,
      slotIndex: body.slotIndex,
      breakStart: body.breakStart,
      breakEnd: body.breakEnd,
      noUnpaidBreak: body.noUnpaidBreak,
      preserveBreak: false,
      source: user.role === "staff" ? "Staff schedule edit" : "Student schedule change",
      by: user.name
    });
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  const scheduleChangeMatch = url.pathname.match(/^\/api\/schedule-change-requests\/([^/]+)\/action$/);
  if (req.method === "POST" && scheduleChangeMatch) {
    requireStaff(user);
    const request = db.scheduleChangeRequests.find((item) => item.id === decodeURIComponent(scheduleChangeMatch[1]));
    if (!request) {
      sendJson(res, 404, { error: "Schedule change request not found" });
      return;
    }
    const body = await readJson(req);
    const action = cleanText(body.action);
    if (!["approve", "reject"].includes(action)) {
      sendJson(res, 400, { error: "Action not allowed" });
      return;
    }
    handleScheduleChangeRequestAction(request, action, user);
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
    if (user.role !== "staff") {
      createScheduleChangeRequest(worker, { slotIndex }, user, "remove");
      saveDb();
      sendJson(res, 202, viewForUser(user));
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

  const eventCoverageMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/coverage-action$/);
  if (req.method === "POST" && eventCoverageMatch) {
    requireStaff(user);
    const event = db.events.find((item) => item.id === decodeURIComponent(eventCoverageMatch[1]));
    if (!event) {
      sendJson(res, 404, { error: "Event not found" });
      return;
    }
    const body = await readJson(req);
    const action = cleanText(body.action);
    if (!["covered", "reject"].includes(action)) {
      sendJson(res, 400, { error: "Action not allowed" });
      return;
    }
    handleStaffEventCoverageAction(event, action, user);
    saveDb();
    sendJson(res, 200, viewForUser(user));
    return;
  }

  const eventCoverageBlockMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/coverage-blocks$/);
  if (req.method === "POST" && eventCoverageBlockMatch) {
    requireStaff(user);
    const event = db.events.find((item) => item.id === decodeURIComponent(eventCoverageBlockMatch[1]));
    if (!event) {
      sendJson(res, 404, { error: "Event not found" });
      return;
    }
    const body = await readJson(req);
    handleStaffCoverageBlock(event, body, user);
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

function createScheduleChangeRequest(worker, input, user, type = "change") {
  db.scheduleChangeRequests ||= [];
  const normalized = normalizeScheduleChangeRequest(worker, input, type);
  const request = {
    id: `schedule-change-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    workerId: worker.id,
    status: "pending",
    type,
    day: normalized.day,
    date: normalized.date,
    space: normalized.space,
    start: normalized.start,
    end: normalized.end,
    breakStart: normalized.breakStart,
    breakEnd: normalized.breakEnd,
    mode: normalized.mode,
    slotIndex: normalized.slotIndex,
    originalSlot: normalized.originalSlot,
    requestedBy: user.id,
    requestedByName: user.name,
    createdAt: new Date().toISOString(),
    reviewedAt: "",
    reviewedBy: "",
    reviewNote: ""
  };

  db.scheduleChangeRequests = db.scheduleChangeRequests.filter((item) =>
    !(item.status === "pending" && item.workerId === worker.id && item.date === request.date && item.space === request.space)
  );
  db.scheduleChangeRequests.unshift(request);
  addAlert("warning", "Schedule change needs approval", `${worker.name} requested ${scheduleChangeSummary(request)}.`);
  addActivity(`${worker.name} submitted a schedule change for approval: ${scheduleChangeSummary(request)}.`);
  return request;
}

function normalizeScheduleChangeRequest(worker, input, type) {
  const slotIndex = Number(input.slotIndex);
  const originalSlot = Number.isInteger(slotIndex) && slotIndex >= 0 ? worker.availability[slotIndex] : null;
  if (type === "remove") {
    if (!originalSlot) {
      const error = new Error("Choose a schedule block to remove.");
      error.status = 400;
      throw error;
    }
    return {
      day: originalSlot.day,
      date: originalSlot.date || (DAYS.includes(originalSlot.day) ? addDays(db.focusWeekStart, DAYS.indexOf(originalSlot.day)) : ""),
      space: originalSlot.space,
      start: originalSlot.start,
      end: originalSlot.end,
      mode: "remove",
      slotIndex,
      originalSlot: structuredClone(originalSlot)
    };
  }

  const day = cleanText(input.day);
  const space = normalizeSpaceName(input.space);
  const start = normalizeTimeValue(input.start, "09:00");
  const end = normalizeTimeValue(input.end, "17:00");
  const mode = cleanText(input.mode) || "add";
  const breakStart = normalizeTimeValue(input.breakStart, "");
  const breakEnd = normalizeTimeValue(input.breakEnd, "");
  const date = normalizeDateValue(input.date) || (DAYS.includes(day) ? addDays(db.focusWeekStart, DAYS.indexOf(day)) : "");
  if (!DAYS.includes(day) || minutes(end) <= minutes(start)) {
    const error = new Error("Invalid schedule block.");
    error.status = 400;
    throw error;
  }
  if (mode === "split-day" && !(minutes(start) < minutes(breakStart) && minutes(breakStart) < minutes(breakEnd) && minutes(breakEnd) < minutes(end))) {
    const error = new Error("For split day, start must be before away start, away start before back time, and back time before end.");
    error.status = 400;
    throw error;
  }
  if (mode === "edit-slot" && !originalSlot) {
    const error = new Error("Choose a schedule block to edit.");
    error.status = 400;
    throw error;
  }
  return {
    day,
    date,
    space,
    start,
    end,
    breakStart: mode === "split-day" ? breakStart : "",
    breakEnd: mode === "split-day" ? breakEnd : "",
    mode,
    slotIndex: Number.isInteger(slotIndex) ? slotIndex : "",
    originalSlot: originalSlot ? structuredClone(originalSlot) : null
  };
}

function handleScheduleChangeRequestAction(request, action, user) {
  if (request.status !== "pending") {
    const error = new Error("This schedule change has already been reviewed.");
    error.status = 400;
    throw error;
  }
  if (action === "reject") {
    request.status = "rejected";
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = user.name;
    request.reviewNote = "Rejected by staff.";
    const worker = db.workers.find((item) => item.id === request.workerId);
    addAlert("info", "Schedule change rejected", `${worker?.name || "Student"}'s request was rejected.`);
    addActivity(`${user.name} rejected ${worker?.name || "student"} schedule request: ${scheduleChangeSummary(request)}.`);
    return;
  }

  const worker = db.workers.find((item) => item.id === request.workerId);
  if (!worker) {
    const error = new Error("Worker not found.");
    error.status = 404;
    throw error;
  }
  if (request.type === "remove") {
    removeScheduleBlockFromApprovedRequest(worker, request, user);
  } else {
    const slotIndex = request.mode === "edit-slot" && request.originalSlot
      ? findScheduleSlotIndex(worker, request.originalSlot)
      : request.slotIndex;
    if (request.mode === "edit-slot" && slotIndex === -1) {
      const error = new Error("That schedule block is no longer on the student's schedule.");
      error.status = 400;
      throw error;
    }
    applyScheduleChange(worker, {
      date: request.date,
      day: request.day,
      space: request.space,
      start: request.start,
      end: request.end,
      breakStart: request.breakStart,
      breakEnd: request.breakEnd,
      mode: request.mode,
      slotIndex,
      source: "Student schedule change",
      by: request.requestedByName || "Student"
    });
  }
  request.status = "approved";
  request.reviewedAt = new Date().toISOString();
  request.reviewedBy = user.name;
  request.reviewNote = "Approved by staff.";
  addAlert("info", "Schedule change approved", `${worker.name}'s request was approved: ${scheduleChangeSummary(request)}.`);
  addActivity(`${user.name} approved ${worker.name} schedule request: ${scheduleChangeSummary(request)}.`);
}

function removeScheduleBlockFromApprovedRequest(worker, request, user) {
  const index = findScheduleSlotIndex(worker, request.originalSlot || request);
  if (index === -1) {
    const error = new Error("That schedule block is no longer on the student's schedule.");
    error.status = 400;
    throw error;
  }
  const removed = worker.availability.splice(index, 1)[0];
  addAlert("warning", "Schedule removed", `${user.name} approved removing ${worker.name}'s ${removed.space} block on ${removed.day}, ${formatTime(removed.start)}-${formatTime(removed.end)}.`);
  addActivity(`Approved removal of ${worker.name} schedule block at ${removed.space}.`);
}

function findScheduleSlotIndex(worker, slotItem) {
  return (worker.availability || []).findIndex((item) =>
    item.day === slotItem.day &&
    (item.date || "") === (slotItem.date || "") &&
    item.space === slotItem.space &&
    item.start === slotItem.start &&
    item.end === slotItem.end
  );
}

function scheduleChangeSummary(request) {
  const verb = request.type === "remove" ? "remove" : "change";
  if (request.mode === "split-day") {
    return `${verb} ${request.space} on ${request.day}, ${formatTime(request.start)}-${formatTime(request.breakStart)} and ${formatTime(request.breakEnd)}-${formatTime(request.end)}`;
  }
  return `${verb} ${request.space} on ${request.day}, ${formatTime(request.start)}-${formatTime(request.end)}`;
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
      .filter((item) => sameCoverageScope(item, request) && item.id !== request.id && item.status === "pending")
      .forEach((item) => {
        item.status = "closed";
        item.respondedAt = new Date().toISOString();
        item.reason = `Accepted by ${worker.name}.`;
      });
    updateCoverageBlockFromRequest(event, request, {
      status: "accepted",
      workerId: worker.id,
      note: `Accepted by ${worker.name}.`
    });
    addAlert("info", "Coverage accepted", `${worker.name} accepted ${event.title} at ${event.space}, ${formatShortDate(event.date)} ${formatTime(requestStart(request, event))}-${formatTime(requestEnd(request, event))}.`);
    addActivity(`${worker.name} accepted after-hours coverage for "${event.title}" (${formatTime(requestStart(request, event))}-${formatTime(requestEnd(request, event))}).`);
    return;
  }

  if (action === "deny") {
    request.status = "denied";
    request.respondedAt = new Date().toISOString();
    const openRequests = db.coverageRequests.filter((item) => sameCoverageScope(item, request) && ["pending", "accepted", "scheduled"].includes(item.status));
    if (!openRequests.length) {
      updateCoverageBlockFromRequest(event, request, { status: "needs-review", note: "Student denied this coverage block." });
      if (!db.coverageRequests.some((item) => item.eventId === event.id && ["pending", "accepted", "scheduled"].includes(item.status))) event.status = "needs-review";
    }
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
    const start = requestStart(request, event);
    const end = requestEnd(request, event);
    const missingSegments = missingScheduleSegments(worker, day, event.date, start, end);
    missingSegments.forEach((segment) => {
      applyScheduleChange(worker, {
        date: event.date,
        day,
        space: event.space,
        start: segment.start,
        end: segment.end,
        mode: "add",
        source: "Accepted event coverage",
        by: user.name
      });
    });
    request.status = "scheduled";
    request.respondedAt = new Date().toISOString();
    updateCoverageBlockFromRequest(event, request, {
      status: "scheduled",
      workerId: worker.id,
      note: `Scheduled with ${worker.name}.`
    });
    event.status = eventCoverageComplete(event) ? "scheduled" : "requesting";
    event.assignedTo = worker.id;
    addAlert("info", "Event added to schedule", `${worker.name} added ${event.title} to their schedule. Supervisors can now see it on the weekly board.`);
    addActivity(`${worker.name} added "${event.title}" to their schedule.`);
  }
}

function handleStaffCoverageBlock(event, input, user) {
  if (!event.afterHours) {
    const error = new Error("Only after-hours events can be split into coverage blocks");
    error.status = 400;
    throw error;
  }

  const start = normalizeTimeValue(input.start, "");
  const end = normalizeTimeValue(input.end, "");
  const mode = cleanText(input.mode) || "request";
  const workerId = cleanText(input.workerId);
  if (!start || !end || minutes(end) <= minutes(start) || minutes(start) < minutes(event.start) || minutes(end) > minutes(event.end)) {
    const error = new Error("Coverage block must fit inside the event time.");
    error.status = 400;
    throw error;
  }

  const worker = mode === "covered" ? null : db.workers.find((item) => item.id === workerId);
  if (mode !== "covered" && !worker) {
    const error = new Error("Choose a student worker for this coverage block.");
    error.status = 400;
    throw error;
  }

  event.coverageBlocks ||= [];
  const block = {
    id: `block-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    start,
    end,
    status: mode === "covered" ? "covered" : "requesting",
    workerId: mode === "covered" ? "" : workerId,
    resolvedBy: mode === "covered" ? user.name : "",
    resolvedAt: mode === "covered" ? new Date().toISOString() : "",
    note: mode === "covered" ? "Covered by staff / no student needed." : ""
  };
  event.coverageBlocks.push(block);

  if (mode === "covered") {
    event.status = eventCoverageComplete(event) ? "covered" : "requesting";
    addAlert("info", "Coverage block cleared", `${user.name} cleared ${event.title}, ${formatTime(start)}-${formatTime(end)}.`);
    addActivity(`${user.name} cleared ${event.title} coverage ${formatTime(start)}-${formatTime(end)}.`);
    return;
  }

  const created = createCoverageRequestsForEvent(event, db, {
    workerId,
    coverageBlockId: block.id,
    start,
    end,
    reason: `Staff requested ${formatTime(start)}-${formatTime(end)} coverage.`
  });
  event.status = "requesting";
  addAlert("info", "Coverage block assigned", `${event.title}: asked ${worker.name} to cover ${formatTime(start)}-${formatTime(end)}.`);
  addActivity(`${user.name} requested ${worker.name} for "${event.title}" ${formatTime(start)}-${formatTime(end)}.`);
  if (!created.length) block.note = `Already requested ${worker.name}.`;
}

function handleStaffEventCoverageAction(event, action, user) {
  if (!event.afterHours) {
    const error = new Error("Only after-hours events can be cleared for coverage");
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const relatedRequests = db.coverageRequests.filter((request) => request.eventId === event.id);

  if (action === "covered") {
    event.status = "covered";
    event.assignedTo = "";
    event.resolvedAt = now;
    event.resolvedBy = user.name;
    event.coverageBlocks = (event.coverageBlocks || []).map((block) => ({
      ...block,
      status: "covered",
      resolvedBy: user.name,
      resolvedAt: now,
      note: "Staff marked coverage not needed."
    }));
    relatedRequests.forEach((request) => {
      request.status = "covered";
      request.respondedAt = now;
      request.reason = "Staff marked coverage not needed.";
    });
    addAlert("info", "Coverage cleared", `${user.name} marked ${event.title} at ${event.space} as covered / not needing student coverage.`);
    addActivity(`${user.name} cleared after-hours coverage for "${event.title}" as covered.`);
    return;
  }

  if (action === "reject") {
    event.status = "rejected";
    event.assignedTo = "";
    event.resolvedAt = now;
    event.resolvedBy = user.name;
    event.coverageBlocks = (event.coverageBlocks || []).map((block) => ({
      ...block,
      status: "rejected",
      resolvedBy: user.name,
      resolvedAt: now,
      note: "Staff dismissed this coverage block."
    }));
    relatedRequests.forEach((request) => {
      request.status = "dismissed";
      request.respondedAt = now;
      request.reason = "Staff dismissed this coverage request.";
    });
    addAlert("info", "Coverage request dismissed", `${user.name} dismissed ${event.title} at ${event.space}.`);
    addActivity(`${user.name} dismissed the after-hours coverage request for "${event.title}".`);
  }
}

function sameCoverageScope(left, right) {
  return left.eventId === right.eventId &&
    (left.coverageBlockId || "") === (right.coverageBlockId || "") &&
    (left.start || "") === (right.start || "") &&
    (left.end || "") === (right.end || "");
}

function requestStart(request, event) {
  return request.start || event.start;
}

function requestEnd(request, event) {
  return request.end || event.end;
}

function missingScheduleSegments(worker, day, date, start, end) {
  const startMinute = minutes(start);
  const endMinute = minutes(end);
  const covered = (worker.availability || [])
    .filter((slotItem) => scheduleItemMatchesDate(slotItem, day, date))
    .map((slotItem) => ({
      start: Math.max(startMinute, minutes(slotItem.start)),
      end: Math.min(endMinute, minutes(slotItem.end))
    }))
    .filter((slotItem) => slotItem.end > slotItem.start)
    .sort((a, b) => a.start - b.start);
  const missing = [];
  let cursor = startMinute;

  covered.forEach((slotItem) => {
    if (slotItem.start > cursor) missing.push({ start: timeFromMinutes(cursor), end: timeFromMinutes(slotItem.start) });
    if (slotItem.end > cursor) cursor = slotItem.end;
  });
  if (cursor < endMinute) missing.push({ start: timeFromMinutes(cursor), end: timeFromMinutes(endMinute) });
  return missing;
}

function updateCoverageBlockFromRequest(event, request, updates) {
  const blockId = request.coverageBlockId || "";
  if (!blockId) return;
  event.coverageBlocks ||= [];
  const block = event.coverageBlocks.find((item) => item.id === blockId);
  if (!block) return;
  Object.assign(block, updates, {
    resolvedAt: ["covered", "scheduled", "rejected"].includes(updates.status) ? new Date().toISOString() : block.resolvedAt || ""
  });
}

function eventCoverageComplete(event) {
  const blocks = event.coverageBlocks || [];
  if (!blocks.length) return ["scheduled", "covered", "rejected"].includes(event.status);
  return coverageBlocksCoverEvent(event) && blocks.every((block) => ["covered", "scheduled", "rejected"].includes(block.status));
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

function viewForUser(user) {
  const coverageGaps = getCoverageGaps();
  const coverageSuggestions = getCoverageSuggestions(coverageGaps);
  const currentUser = publicUser(user);
  const visibleEvents = db.events.filter((event) => !isLegacyBookingImport(event));
  const visibleCoverageRequests = db.coverageRequests.filter((request) => {
    const event = db.events.find((item) => item.id === request.eventId);
    return event && !isLegacyBookingImport(event);
  });
  const base = {
    currentUser,
    role: user.role,
    focusDate: db.focusDate,
    focusWeekStart: db.focusWeekStart,
    spaces: db.spaces,
    events: visibleEvents.map(publicEvent),
    staffSchedules: cleanStaffSchedules(db.staffSchedules),
    staffStatuses: staffStatusesForDate(db.focusDate),
    staffStatusRecords: cleanStaffStatusRecords(db.staffStatuses).map(publicStaffStatus),
    staffStatusPeople: STAFF_STATUS_PEOPLE,
    staffStatusOptions: STAFF_STATUS_OPTIONS,
    scheduleChangeRequests: scheduleChangeRequestsForUser(user).map((request) => publicScheduleChangeRequest(request, user.role === "staff")),
    spaceColors: SPACE_COLORS,
    skillOptions: SKILL_OPTIONS,
    storage: storageStatusForClient(),
    integrations: {
      mazevo: mazevoStatusForClient()
    },
    workers: db.workers.map((worker) => publicWorker(worker, user.role === "staff")),
    coverageGaps,
    coverageSuggestions
  };

  if (user.role === "staff") {
    return {
      ...base,
      tasks: db.tasks,
      coverageRequests: visibleCoverageRequests.map(publicCoverageRequest),
      alerts: buildAlerts(coverageGaps),
      activity: db.activity,
      users: db.users.map(publicUser)
    };
  }

  const studentRequests = visibleCoverageRequests.filter((request) => request.workerId === user.workerId && coverageRequestInFocusWeek(request, db));
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
    availability: worker.availability.map((slotItem) => publicScheduleSlot(slotItem, forStaff)),
    weeklyHours,
    weeklyLimit: WEEKLY_HOUR_LIMIT,
    remainingHours: Math.max(0, roundHours(WEEKLY_HOUR_LIMIT - weeklyHours)),
    overLimit: weeklyHours > WEEKLY_HOUR_LIMIT
  };
}

function publicScheduleSlot(slotItem, forStaff) {
  const visible = {
    day: slotItem.day,
    space: slotItem.space,
    start: slotItem.start,
    end: slotItem.end,
    source: slotItem.source || "",
    paidHours: paidHoursForScheduleItem(slotItem)
  };
  if (slotItem.date) visible.date = slotItem.date;
  if (forStaff && slotItem.unpaidBreakMinutes !== undefined) {
    visible.unpaidBreakMinutes = slotItem.unpaidBreakMinutes;
  }
  return visible;
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
    createdAt: event.createdAt || "",
    source: event.source || "",
    externalId: event.externalId || "",
    mazevoStatus: event.mazevoStatus || "",
    mazevoEventNumber: event.mazevoEventNumber || "",
    mazevoBookingId: event.mazevoBookingId || "",
    mazevoRoomDescription: event.mazevoRoomDescription || "",
    mazevoBuildingDescription: event.mazevoBuildingDescription || "",
    coverageBlocks: (event.coverageBlocks || []).map(publicCoverageBlock),
    importedAt: event.importedAt || ""
  };
}

function publicCoverageBlock(block) {
  return {
    id: block.id,
    start: block.start,
    end: block.end,
    status: block.status || "requesting",
    workerId: block.workerId || "",
    resolvedBy: block.resolvedBy || "",
    note: block.note || ""
  };
}

function publicCoverageRequest(request) {
  return {
    id: request.id,
    eventId: request.eventId,
    coverageBlockId: request.coverageBlockId || "",
    workerId: request.workerId,
    status: request.status,
    start: request.start || "",
    end: request.end || "",
    score: request.score || 0,
    reason: request.reason || "",
    createdAt: request.createdAt || "",
    respondedAt: request.respondedAt || ""
  };
}

function scheduleChangeRequestsForUser(user) {
  const requests = db.scheduleChangeRequests || [];
  if (user.role === "staff") return requests;
  return requests.filter((request) => request.workerId === user.workerId);
}

function publicScheduleChangeRequest(request, forStaff) {
  return {
    id: request.id,
    workerId: request.workerId,
    status: request.status || "pending",
    type: request.type || "change",
    day: request.day || "",
    date: request.date || "",
    space: request.space || "",
    start: request.start || "",
    end: request.end || "",
    breakStart: request.breakStart || "",
    breakEnd: request.breakEnd || "",
    mode: request.mode || "",
    originalSlot: request.originalSlot ? publicScheduleSlot(request.originalSlot, forStaff) : null,
    requestedByName: request.requestedByName || "",
    createdAt: request.createdAt || "",
    reviewedAt: request.reviewedAt || "",
    reviewedBy: request.reviewedBy || "",
    reviewNote: request.reviewNote || ""
  };
}

function buildAlerts(gaps) {
  const gapAlerts = gaps.slice(0, 10).map(gapToAlert);
  const eventAlerts = db.events
    .filter((event) => !isLegacyBookingImport(event) && event.afterHours && isDateInFocusWeek(event.date) && ["needs-review", "requesting", "accepted"].includes(event.status))
    .slice(0, 8)
    .map(eventToAlert);
  const scheduleAlerts = (db.scheduleChangeRequests || [])
    .filter((request) => request.status === "pending")
    .slice(0, 6)
    .map(scheduleChangeToAlert);
  return [...scheduleAlerts, ...eventAlerts, ...gapAlerts, ...(db.alerts || []).slice(0, 8)];
}

function gapToAlert(gap) {
  return {
    level: "warning",
    title: `${gap.space} has an uncovered time`,
    message: `${formatShortDate(gap.date)} from ${gap.detail}. ${gap.blocks.length ? `Other scheduled blocks that day: ${gap.blocks.join(", ")}.` : "No one is scheduled at that space that day."}`
  };
}

function scheduleChangeToAlert(request) {
  const worker = db.workers.find((item) => item.id === request.workerId);
  return {
    level: "warning",
    title: "Schedule approval needed",
    message: `${worker?.name || "Student"} requested to ${scheduleChangeSummary(request)}.`
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
  return Boolean(event && !isLegacyBookingImport(event) && isDateInFocusWeek(event.date, appDb.focusWeekStart));
}

function createInitialDb() {
  const initial = {
    seedVersion: CURRENT_SEED_VERSION,
    focusDate: FALLBACK_FOCUS_DATE,
    focusWeekStart: SOURCE_WEEK_START,
    spaces: cleanSpaces(structuredClone(seedData.spaces)),
    workers: structuredClone(seedData.workers),
    staffSchedules: structuredClone(seedData.staffSchedules),
    events: cleanEvents(seedData.events.map(createScheduleEvent)),
    coverageRequests: [],
    scheduleChangeRequests: [],
    staffStatuses: [],
    tasks: [],
    activity: [],
    alerts: [],
    airtable: {},
    integrations: { mazevo: {} },
    users: []
  };
  ensureObservedClosedDates(initial);
  initial.staffSchedules = cleanStaffSchedules(initial.staffSchedules);

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

  ensureSakshiWorker(initial);
  ensureNoUnpaidBreakOverrides(initial);
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

async function loadDbForRuntime() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (airtableBackendRequested()) {
    try {
      const sharedDb = await loadDbFromAirtableState();
      if (sharedDb) {
        const migrated = migrateDb(sharedDb);
        fs.writeFileSync(DATA_FILE, JSON.stringify(migrated, null, 2));
        airtableStateActive = true;
        return migrated;
      }
      const initial = loadDb();
      fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
      await saveDbToAirtableState(initial);
      airtableStateActive = true;
      return initial;
    } catch (error) {
      airtableStateActive = false;
      console.warn(`Airtable shared backend unavailable: ${error.message}`);
    }
  }
  return loadDb();
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
  appDb.integrations ||= {};
  appDb.integrations.mazevo ||= {};
  appDb.spaces = cleanSpaces(appDb.spaces || structuredClone(seedData.spaces));
  ensureObservedClosedDates(appDb);
  appDb.staffSchedules = cleanStaffSchedules(appDb.staffSchedules || structuredClone(seedData.staffSchedules));
  appDb.staffStatuses = cleanStaffStatusRecords(appDb.staffStatuses || []);
  appDb.events ||= seedData.events.map(createScheduleEvent);
  appDb.coverageRequests ||= [];
  appDb.scheduleChangeRequests ||= [];
  appDb.users ||= [];
  ensureSakshiWorker(appDb);
  appDb.workers.forEach((worker) => {
    worker.skills = normalizeSkillList(worker.skills || []);
    worker.primarySpaces ||= [];
    worker.availability ||= [];
  });
  ensureNoUnpaidBreakOverrides(appDb);
  appDb.tasks.forEach((task) => {
    task.deniedBy ||= [];
    task.requiredSkills = normalizeSkillList(task.requiredSkills || []);
    if (!task.requiredSkills.length) task.requiredSkills = inferTaskSkills(task);
    task.priority ||= "Normal";
    task.status ||= "draft";
  });
  appDb.events = cleanEvents(appDb.events.map((event) => normalizeScheduleEvent(event)));
  appDb.coverageRequests.forEach((request) => {
    request.status ||= "pending";
    request.coverageBlockId ||= "";
    request.start ||= "";
    request.end ||= "";
    request.createdAt ||= new Date().toISOString();
    request.respondedAt ||= "";
    request.reason ||= "";
    request.score ||= 0;
  });
  appDb.coverageRequests = cleanCoverageRequests(appDb.coverageRequests, appDb.events);
  appDb.scheduleChangeRequests.forEach((request) => {
    request.status ||= "pending";
    request.type ||= "change";
    request.mode ||= request.type === "remove" ? "remove" : "add";
    request.createdAt ||= new Date().toISOString();
    request.reviewedAt ||= "";
    request.reviewedBy ||= "";
    request.reviewNote ||= "";
    request.originalSlot ||= null;
    request.breakStart ||= "";
    request.breakEnd ||= "";
  });
  if (!appDb.coverageRequests.length) {
    ensureCoverageRequestsForFocusWeek(appDb);
  }
  ensureSharedOwnerCoverageRequests(appDb);
  if (!appDb.users.length) {
    appDb.users = createInitialDb().users;
  }
  return appDb;
}

function ensureObservedClosedDates(appDb) {
  appDb.spaces ||= [];
  appDb.spaces.forEach((space) => {
    space.closedDates ||= [];
    OBSERVED_CLOSED_DATES.forEach((date) => {
      if (!space.closedDates.includes(date)) space.closedDates.push(date);
    });
    space.closedDates.sort();
  });
}

function ensureSakshiWorker(appDb) {
  appDb.workers ||= [];
  const worker = appDb.workers.find((item) => item.id === SAKSHI_WORKER_ID);
  const sakshi = worker || {
    id: SAKSHI_WORKER_ID,
    name: "Sakshi",
    role: "Student Worker",
    initials: "SK",
    supervisor: "Unassigned",
    primarySpaces: ["850PBC"],
    skills: ["coverage", "customer-service", "events"],
    availability: []
  };

  sakshi.name = "Sakshi";
  sakshi.role ||= "Student Worker";
  sakshi.initials ||= "SK";
  sakshi.supervisor ||= "Unassigned";
  sakshi.primarySpaces = ["850PBC"];
  sakshi.skills = normalizeSkillList([...(sakshi.skills || []), "coverage", "customer-service", "events"]);
  const endDate = latestScheduleDate(appDb) || "2026-07-31";
  sakshi.availability = [
    ...(sakshi.availability || []).filter((slotItem) => slotItem.source !== SAKSHI_DEFAULT_SCHEDULE_SOURCE)
  ];
  sakshi.availability.push(...sakshiSummerSchedule(appDb, sakshi.availability, endDate));
  sakshi.availability.sort(sortScheduleSlots);

  if (!worker) appDb.workers.push(sakshi);
}

function ensureNoUnpaidBreakOverrides(appDb) {
  NO_UNPAID_BREAK_OVERRIDES.forEach((override) => {
    const worker = (appDb.workers || []).find((item) => item.id === override.workerId);
    if (!worker) return;
    (worker.availability || []).forEach((slotItem) => {
      if (!slotItem.date || slotItem.date < override.startDate || slotItem.date > override.endDate) return;
      const durationMinutes = Math.max(0, minutes(slotItem.end) - minutes(slotItem.start));
      if (durationMinutes < NO_UNPAID_BREAK_OVERRIDE_MINUTES) return;
      slotItem.unpaidBreakMinutes = 0;
    });
  });
}

function sakshiSummerSchedule(appDb, existingAvailability = [], endDate = latestScheduleDate(appDb) || "2026-07-31") {
  const schedule = [];
  for (let date = SAKSHI_START_DATE; date <= endDate; date = addDays(date, 1)) {
    const day = dayFromDate(date);
    if (!["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].includes(day)) continue;
    if (hasManualScheduleOverride(existingAvailability, date, "850PBC")) continue;
    schedule.push(slot(
      day,
      "850PBC",
      "07:45",
      day === "Friday" ? "13:45" : "16:15",
      SAKSHI_DEFAULT_SCHEDULE_SOURCE,
      date
    ));
  }
  return schedule;
}

function hasManualScheduleOverride(availability, date, space) {
  return (availability || []).some((slotItem) =>
    slotItem.date === date &&
    cleanText(slotItem.space) === space &&
    SCHEDULE_OVERRIDE_SOURCES.has(cleanText(slotItem.source))
  );
}

function latestScheduleDate(appDb) {
  return (appDb.workers || [])
    .flatMap((worker) => (worker.availability || []).map((slotItem) => slotItem.date).filter(Boolean))
    .sort()
    .at(-1) || "";
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  if (airtableBackendEnabled()) queueAirtableStateSave(db);
}

function airtableConfigured() {
  return Boolean(process.env.AIRTABLE_PAT && process.env.AIRTABLE_BASE_ID);
}

function airtableBackendRequested() {
  return AIRTABLE_BACKEND_ENABLED && airtableConfigured();
}

function airtableBackendEnabled() {
  return airtableStateActive;
}

function airtableStatus() {
  return {
    configured: airtableConfigured(),
    sharedBackend: airtableBackendEnabled(),
    storageMode: airtableBackendEnabled() ? "airtable" : "local-json",
    baseId: process.env.AIRTABLE_BASE_ID ? maskValue(process.env.AIRTABLE_BASE_ID) : "",
    tables: AIRTABLE_TABLES,
    stateKey: AIRTABLE_STATE_KEY,
    missing: [
      process.env.AIRTABLE_PAT ? "" : "AIRTABLE_PAT",
      process.env.AIRTABLE_BASE_ID ? "" : "AIRTABLE_BASE_ID",
      AIRTABLE_BACKEND_ENABLED ? "" : "AIRTABLE_BACKEND"
    ].filter(Boolean),
    lastSyncAt: db.airtable?.lastSyncAt || "",
    lastSyncSummary: db.airtable?.lastSyncSummary || null,
    lastStateSaveAt: db.airtable?.lastStateSaveAt || "",
    lastStateSaveError: db.airtable?.lastStateSaveError || ""
  };
}

function storageStatusForClient() {
  const status = airtableStatus();
  return {
    mode: status.storageMode,
    shared: status.sharedBackend,
    configured: status.configured,
    baseId: status.baseId,
    stateTable: AIRTABLE_TABLES.state,
    lastStateSaveAt: status.lastStateSaveAt,
    lastStateSaveError: status.lastStateSaveError
  };
}

function mazevoConfigured() {
  return Boolean(MAZEVO_BASE_URL && MAZEVO_API_KEY);
}

function mazevoStatus() {
  return {
    configured: mazevoConfigured(),
    baseUrl: MAZEVO_BASE_URL ? maskValue(MAZEVO_BASE_URL) : "",
    endpoint: MAZEVO_EVENTS_ENDPOINT,
    method: MAZEVO_EVENTS_METHOD,
    authHeader: MAZEVO_AUTH_HEADER,
    confirmedStatuses: MAZEVO_CONFIRMED_STATUSES,
    lookaheadDays: MAZEVO_LOOKAHEAD_DAYS,
    missing: [
      MAZEVO_BASE_URL ? "" : "MAZEVO_BASE_URL",
      MAZEVO_API_KEY ? "" : "MAZEVO_API_KEY"
    ].filter(Boolean),
    lastSyncAt: db.integrations?.mazevo?.lastSyncAt || "",
    lastSyncSummary: db.integrations?.mazevo?.lastSyncSummary || null,
    lastSyncError: db.integrations?.mazevo?.lastSyncError || ""
  };
}

function mazevoStatusForClient() {
  const status = mazevoStatus();
  return {
    configured: status.configured,
    endpoint: status.endpoint,
    method: status.method,
    lastSyncAt: status.lastSyncAt,
    lastSyncSummary: status.lastSyncSummary,
    lastSyncError: status.lastSyncError,
    missing: status.missing
  };
}

function mazevoSyncSecretAllowed(req) {
  if (!MAZEVO_SYNC_SECRET) return false;
  const headerSecret = cleanText(req.headers["x-sync-secret"]);
  const auth = cleanText(req.headers.authorization);
  const bearerSecret = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return secureCompare(headerSecret, MAZEVO_SYNC_SECRET) || secureCompare(bearerSecret, MAZEVO_SYNC_SECRET);
}

function secureCompare(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function syncMazevoEvents(options = {}) {
  if (!mazevoConfigured()) {
    const error = new Error("Mazevo is not configured. Set MAZEVO_BASE_URL and MAZEVO_API_KEY in Render.");
    error.status = 400;
    throw error;
  }

  const from = normalizeDateValue(options.from || options.startDate) || new Date().toISOString().slice(0, 10);
  const to = normalizeDateValue(options.to || options.endDate) || addDays(from, MAZEVO_LOOKAHEAD_DAYS);
  const summary = {
    from,
    to,
    fetched: 0,
    imported: 0,
    updated: 0,
    skippedUnconfirmed: 0,
    skippedInvalid: 0,
    requestsCreated: 0,
    duplicatesRemoved: 0,
    legacyBookingsRemoved: 0,
    staleMazevoEventsRemoved: 0,
    endpoint: MAZEVO_EVENTS_ENDPOINT,
    syncedAt: new Date().toISOString()
  };

  try {
    const payload = await fetchMazevoEvents({ from, to });
    const records = extractMazevoEventRecords(payload);
    summary.fetched = records.length;
    const syncedEventIds = new Set();

    records.forEach((record) => {
      const mapped = mapMazevoRecordToEvent(record);
      if (mapped.skip === "unconfirmed") {
        summary.skippedUnconfirmed += 1;
        return;
      }
      if (!mapped.event) {
        summary.skippedInvalid += 1;
        return;
      }
      const result = upsertMazevoEvent(mapped.event);
      if (result.eventId) syncedEventIds.add(result.eventId);
      summary[result.action] += 1;
      summary.requestsCreated += result.requestsCreated;
      summary.duplicatesRemoved += result.duplicatesRemoved || 0;
    });
    summary.staleMazevoEventsRemoved = removeStaleMazevoEvents(db, { from, to, keepIds: syncedEventIds });
    summary.legacyBookingsRemoved = removeLegacyBookingImports(db, { from, to });

    db.integrations ||= {};
    db.integrations.mazevo = {
      lastSyncAt: summary.syncedAt,
      lastSyncSummary: summary,
      lastSyncError: ""
    };
    addAlert("info", "Mazevo synced", `Imported ${summary.imported} and updated ${summary.updated} confirmed Mazevo event${summary.imported + summary.updated === 1 ? "" : "s"}.`);
    addActivity(`Synced Mazevo events: ${summary.imported} imported, ${summary.updated} updated, ${summary.legacyBookingsRemoved + summary.duplicatesRemoved + summary.staleMazevoEventsRemoved} old booking import${summary.legacyBookingsRemoved + summary.duplicatesRemoved + summary.staleMazevoEventsRemoved === 1 ? "" : "s"} cleared.`);
    return summary;
  } catch (error) {
    db.integrations ||= {};
    db.integrations.mazevo ||= {};
    db.integrations.mazevo.lastSyncError = error.message;
    try {
      saveDb();
    } catch (saveError) {
      console.warn(`Mazevo sync error could not be saved: ${saveError.message}`);
    }
    throw error;
  }
}

async function fetchMazevoEvents({ from, to }) {
  const method = ["GET", "POST"].includes(MAZEVO_EVENTS_METHOD) ? MAZEVO_EVENTS_METHOD : "POST";
  const url = mazevoRequestUrl(from, to, method);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (!MAZEVO_API_KEY_QUERY_PARAM) {
    headers[MAZEVO_AUTH_HEADER] = MAZEVO_AUTH_PREFIX ? `${MAZEVO_AUTH_PREFIX} ${MAZEVO_API_KEY}` : MAZEVO_API_KEY;
  }
  const body = method === "GET" ? undefined : JSON.stringify({
    start: `${from}T00:00:00-07:00`,
    end: `${to}T23:59:59-07:00`,
    startDate: from,
    endDate: to,
    StartDate: from,
    EndDate: to,
    buildingIds: [],
    roomIds: [],
    eventTypeIds: [],
    statusIds: [],
    resourceIds: [],
    bookingIds: [],
    contactId: 0,
    organizationId: 0,
    explodeComboRooms: true,
    includeRelatedRooms: true,
    minDateChanged: null,
    includeEventCoordinators: false,
    includeCalendarDetails: true
  });

  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    const parseError = new Error(`Mazevo returned non-JSON data (${response.status}). Check MAZEVO_BASE_URL and MAZEVO_EVENTS_ENDPOINT.`);
    parseError.status = 502;
    throw parseError;
  }
  if (!response.ok) {
    const message = payload.error?.message || payload.message || payload.Message || `Mazevo request failed (${response.status})`;
    const error = new Error(message);
    error.status = 502;
    throw error;
  }
  return payload;
}

function mazevoRequestUrl(from, to, method) {
  const endpoint = /^https?:\/\//i.test(MAZEVO_EVENTS_ENDPOINT)
    ? MAZEVO_EVENTS_ENDPOINT
    : `${MAZEVO_BASE_URL}/${MAZEVO_EVENTS_ENDPOINT.replace(/^\/+/, "")}`;
  const url = new URL(endpoint);
  if (method === "GET") {
    url.searchParams.set("start", `${from}T00:00:00-07:00`);
    url.searchParams.set("end", `${to}T23:59:59-07:00`);
    url.searchParams.set("startDate", from);
    url.searchParams.set("endDate", to);
    url.searchParams.set("StartDate", from);
    url.searchParams.set("EndDate", to);
  }
  if (MAZEVO_API_KEY_QUERY_PARAM) url.searchParams.set(MAZEVO_API_KEY_QUERY_PARAM, MAZEVO_API_KEY);
  return url;
}

function extractMazevoEventRecords(payload) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  const knownKeys = ["events", "Events", "bookings", "Bookings", "reservations", "Reservations", "data", "Data", "results", "Results", "value", "Value"];
  for (const key of knownKeys) {
    if (Array.isArray(payload?.[key])) return payload[key].filter((item) => item && typeof item === "object");
  }
  const arrays = [];
  collectObjectArrays(payload, arrays);
  return arrays.sort((a, b) => b.length - a.length)[0] || [];
}

function collectObjectArrays(value, arrays) {
  if (Array.isArray(value)) {
    const objects = value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (objects.length) arrays.push(objects);
    value.forEach((item) => collectObjectArrays(item, arrays));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach((item) => collectObjectArrays(item, arrays));
}

function mapMazevoRecordToEvent(record) {
  const mazevoStatus = cleanText(mazevoField(record, ["Status", "StatusName", "Status Description", "EventStatus", "EventStatusName", "ReservationStatus", "BookingStatus"]));
  if (!mazevoStatusAllowed(mazevoStatus)) return { skip: "unconfirmed" };

  const mazevoEventNumber = cleanText(mazevoField(record, ["eventNumber", "EventNumber"]));
  const mazevoBookingId = cleanText(mazevoField(record, ["bookingId", "BookingId", "BookingID"]));
  const baseExternalId = cleanText(mazevoField(record, ["EventId", "EventID", "ID", "Id", "ReservationId", "ReservationID", "BookingId", "BookingID", "EventNumber"]));
  const title = cleanText(mazevoField(record, ["EventName", "Event Name", "EventTitle", "Title", "Name", "Description", "Subject"]));
  const startDateTime = mazevoField(record, ["dateTimeStart", "StartDateTime", "Start Date Time", "EventStart", "Start", "StartTime"]);
  const endDateTime = mazevoField(record, ["dateTimeEnd", "EndDateTime", "End Date Time", "EventEnd", "End", "EndTime"]);
  const dateValue = mazevoField(record, ["EventDate", "Event Date", "Date", "StartDate", "Start Date", "MeetingDate"]);
  const startValue = mazevoField(record, ["StartTime", "Start Time", "BeginTime", "Begin Time"]);
  const endValue = mazevoField(record, ["EndTime", "End Time", "FinishTime", "Finish Time"]);
  const roomDescription = cleanText(mazevoField(record, ["roomDescription", "RoomName", "Room Name", "Room", "Space", "Location", "LocationName", "ResourceName", "Resource Description", "ResourceDescription"]));
  const buildingDescription = cleanText(mazevoField(record, ["buildingDescription", "BuildingName", "Building"]));
  const rawSpace = [buildingDescription, roomDescription].filter(Boolean).join(" | ") || roomDescription || buildingDescription;

  const date = mazevoDate(dateValue || startDateTime);
  const start = mazevoTime(startValue || startDateTime, "");
  const end = mazevoTime(endValue || endDateTime, "");
  const space = mapMazevoSpace({ buildingDescription, roomDescription, rawSpace });

  if (!date || !start || !end || minutes(end) <= minutes(start)) return {};

  const idSource = [
    baseExternalId || mazevoEventNumber || mazevoBookingId || title || "mazevo-event",
    date,
    start,
    end,
    buildingDescription,
    roomDescription,
    space
  ].filter(Boolean).join("|");
  return {
    event: {
      id: `mazevo-${crypto.createHash("sha1").update(idSource).digest("hex").slice(0, 14)}`,
      externalId: idSource,
      title: title || "Mazevo Event",
      date,
      space,
      start,
      end,
      notes: `Synced from Mazevo${mazevoStatus ? ` (${mazevoStatus})` : ""}${rawSpace && rawSpace !== space ? `; original space: ${rawSpace}` : ""}.`,
      status: "requesting",
      source: "mazevo",
      mazevoStatus,
      mazevoEventNumber,
      mazevoBookingId,
      mazevoRoomDescription: roomDescription,
      mazevoBuildingDescription: buildingDescription,
      importedAt: new Date().toISOString()
    }
  };
}

function mazevoStatusAllowed(status) {
  if (MAZEVO_CONFIRMED_STATUSES.includes("*")) return true;
  if (!status) return false;
  const clean = status.toLowerCase();
  return MAZEVO_CONFIRMED_STATUSES.some((allowed) => clean === allowed || clean.includes(allowed));
}

function mazevoField(record, names) {
  const targets = new Set(names.map(normalizedMazevoKey));
  return findMazevoField(record, targets);
}

function findMazevoField(value, targets) {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findMazevoField(item, targets);
      if (nested) return nested;
    }
    return "";
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (targets.has(normalizedMazevoKey(key)) && fieldValue !== null && fieldValue !== undefined && fieldValue !== "") return fieldValue;
  }
  for (const fieldValue of Object.values(value)) {
    const nested = findMazevoField(fieldValue, targets);
    if (nested) return nested;
  }
  return "";
}

function normalizedMazevoKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mazevoDate(value) {
  const clean = cleanText(value);
  if (!clean) return "";
  const isoDate = clean.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  return normalizeDateValue(clean);
}

function mazevoTime(value, fallback) {
  const clean = cleanText(value);
  if (!clean) return fallback;
  const isoTime = clean.match(/[T\s](\d{1,2}:\d{2})(?::\d{2})?/);
  if (isoTime) return normalizeTimeValue(isoTime[1], fallback);
  return normalizeTimeValue(clean, fallback);
}

function mapMazevoSpace(value) {
  const clean = typeof value === "object" ? cleanText(value.rawSpace) : cleanText(value);
  const building = typeof value === "object" ? cleanText(value.buildingDescription) : "";
  const room = typeof value === "object" ? cleanText(value.roomDescription) : clean;
  const combined = `${building} ${room} ${clean}`.toLowerCase();
  const map = mazevoSpaceMap();
  const mapped = map[clean.toLowerCase()] || map[building.toLowerCase()] || map[room.toLowerCase()];
  if (mapped) return normalizeSpaceName(mapped);
  if (/\b850\b|850pbc|pbc|suite\s*130|\(130\)/i.test(combined)) return "850PBC";
  if (/1951|suite\s*150|suite\s*151|\(150\)|\(151/i.test(combined)) return "1951@SkySong";
  if (/acic|chandler/i.test(combined)) return "ACIC";
  if (/mesa|studio|studios|mix|media and immersive/i.test(combined)) return "The Studios";
  if (/skysong|sky song/i.test(combined)) return "SkySong";
  return normalizeSpaceName(mapped || clean || "General");
}

function mazevoSpaceMap() {
  const raw = process.env.MAZEVO_SPACE_MAP || "";
  if (!raw.trim()) return {};
  try {
    return Object.fromEntries(Object.entries(JSON.parse(raw)).map(([key, value]) => [key.toLowerCase(), value]));
  } catch (error) {
    return Object.fromEntries(raw
      .split(";")
      .map((pair) => pair.split("=").map((part) => cleanText(part)))
      .filter(([from, to]) => from && to)
      .map(([from, to]) => [from.toLowerCase(), to]));
  }
}

function upsertMazevoEvent(input) {
  const event = createScheduleEvent(input);
  const existing = db.events.find((item) => item.source === "mazevo" && item.externalId === event.externalId) || db.events.find((item) => item.id === event.id);

  if (!existing) {
    if (!event.afterHours) event.status = "scheduled";
    db.events.push(event);
    const duplicatesRemoved = removeLegacyDuplicatesForMazevoEvent(event, db);
    const created = event.afterHours ? createCoverageRequestsForEvent(event, db, { silent: true }) : [];
    return { action: "imported", eventId: event.id, requestsCreated: created.length, duplicatesRemoved };
  }

  const preserveCoverage = existing.afterHours && ["accepted", "scheduled", "covered", "rejected"].includes(existing.status);
  const preservedStatus = preserveCoverage ? existing.status : (event.afterHours ? "requesting" : "scheduled");
  const preservedAssignedTo = preserveCoverage ? existing.assignedTo : "";
  Object.assign(existing, event, {
    id: existing.id,
    createdAt: existing.createdAt || event.createdAt,
    status: preservedStatus,
    assignedTo: preservedAssignedTo
  });
  existing.afterHours = isAfterHoursEvent(existing);
  if (!preserveCoverage) removeOpenCoverageRequestsForEvent(existing.id);
  const duplicatesRemoved = removeLegacyDuplicatesForMazevoEvent(existing, db);
  const created = existing.afterHours && !afterHoursCoverageResolved(existing) ? createCoverageRequestsForEvent(existing, db, { silent: true }) : [];
  return { action: "updated", eventId: existing.id, requestsCreated: created.length, duplicatesRemoved };
}

function removeLegacyDuplicatesForMazevoEvent(mazevoEvent, appDb) {
  const duplicates = appDb.events.filter((event) => isLegacyDuplicateOfMazevoEvent(event, mazevoEvent));
  if (!duplicates.length) return 0;

  const duplicateIds = new Set(duplicates.map((event) => event.id));
  duplicates.forEach((duplicate) => transferResolvedCoverageIfNeeded(duplicate, mazevoEvent, appDb));
  appDb.events = appDb.events.filter((event) => !duplicateIds.has(event.id));
  appDb.coverageRequests = appDb.coverageRequests.filter((request) => !duplicateIds.has(request.eventId));
  return duplicates.length;
}

function removeLegacyBookingImports(appDb, options = {}) {
  const from = normalizeDateValue(options.from);
  const to = normalizeDateValue(options.to);
  const legacyIds = new Set(appDb.events
    .filter((event) => isLegacyBookingImport(event))
    .filter((event) => {
      if (!from && !to) return true;
      if (from && event.date < from) return false;
      if (to && event.date > to) return false;
      return true;
    })
    .map((event) => event.id));
  if (!legacyIds.size) return 0;

  appDb.events = appDb.events.filter((event) => !legacyIds.has(event.id));
  appDb.coverageRequests = appDb.coverageRequests.filter((request) => !legacyIds.has(request.eventId));
  return legacyIds.size;
}

function removeStaleMazevoEvents(appDb, options = {}) {
  const from = normalizeDateValue(options.from);
  const to = normalizeDateValue(options.to);
  const keepIds = options.keepIds || new Set();
  const staleIds = new Set(appDb.events
    .filter((event) => event.source === "mazevo")
    .filter((event) => {
      if (keepIds.has(event.id)) return false;
      if (from && event.date < from) return false;
      if (to && event.date > to) return false;
      return true;
    })
    .map((event) => event.id));
  if (!staleIds.size) return 0;

  appDb.events = appDb.events.filter((event) => !staleIds.has(event.id));
  appDb.coverageRequests = appDb.coverageRequests.filter((request) => !staleIds.has(request.eventId));
  return staleIds.size;
}

function isLegacyBookingImport(event) {
  if (!event || event.source === "mazevo") return false;
  const haystack = `${event.source || ""} ${event.notes || ""} ${event.externalId || ""}`.toLowerCase();
  return /source:\s*bookings(?:\s*\(\d+\))?\.xlsx/.test(haystack)
    || /\bbookings(?:\s*\(\d+\))?\.xlsx\b/.test(haystack);
}

function isLegacyDuplicateOfMazevoEvent(event, mazevoEvent) {
  if (!event || !mazevoEvent || event.id === mazevoEvent.id || event.source === "mazevo") return false;
  if (event.date !== mazevoEvent.date || event.start !== mazevoEvent.start || event.end !== mazevoEvent.end || event.space !== mazevoEvent.space) return false;
  const eventNumber = cleanText(mazevoEvent.mazevoEventNumber);
  if (eventNumber && (`${event.externalId || ""} ${event.notes || ""}`.toLowerCase()).includes(eventNumber.toLowerCase())) return true;
  return titlesLikelySame(event.title, mazevoEvent.title);
}

function transferResolvedCoverageIfNeeded(legacyEvent, mazevoEvent, appDb) {
  if (!["accepted", "scheduled", "covered", "rejected"].includes(legacyEvent.status || "")) return;
  if (!afterHoursCoverageResolved(mazevoEvent)) {
    mazevoEvent.status = legacyEvent.status;
    mazevoEvent.assignedTo = legacyEvent.assignedTo || mazevoEvent.assignedTo || "";
    mazevoEvent.resolvedAt = legacyEvent.resolvedAt || mazevoEvent.resolvedAt || "";
    mazevoEvent.resolvedBy = legacyEvent.resolvedBy || mazevoEvent.resolvedBy || "";
  }
  appDb.coverageRequests
    .filter((request) => request.eventId === legacyEvent.id && ["accepted", "scheduled", "covered"].includes(request.status))
    .forEach((request) => {
      const exists = appDb.coverageRequests.some((item) => item.eventId === mazevoEvent.id && item.workerId === request.workerId);
      if (!exists) request.eventId = mazevoEvent.id;
    });
}

function titlesLikelySame(left, right) {
  const leftTitle = comparableTitle(left);
  const rightTitle = comparableTitle(right);
  if (!leftTitle || !rightTitle) return false;
  if (leftTitle === rightTitle) return true;
  if (leftTitle.length > 14 && rightTitle.includes(leftTitle)) return true;
  if (rightTitle.length > 14 && leftTitle.includes(rightTitle)) return true;
  const leftTokens = new Set(leftTitle.split(" ").filter((token) => token.length > 2));
  const rightTokens = new Set(rightTitle.split(" ").filter((token) => token.length > 2));
  if (!leftTokens.size || !rightTokens.size) return false;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.75;
}

function comparableTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeOpenCoverageRequestsForEvent(eventId) {
  const openStatuses = new Set(["pending", "denied", "closed"]);
  db.coverageRequests = db.coverageRequests.filter((request) => request.eventId !== eventId || !openStatuses.has(request.status));
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

async function loadDbFromAirtableState() {
  const records = await listAirtableRecords(AIRTABLE_TABLES.state);
  const stateRecords = records
    .filter((record) => record.fields?.Key === AIRTABLE_STATE_KEY)
    .sort((a, b) => Number(a.fields?.["Chunk Index"] || 0) - Number(b.fields?.["Chunk Index"] || 0));
  if (!stateRecords.length) return null;
  const payload = stateRecords.map((record) => record.fields?.Payload || "").join("");
  if (!payload) return null;
  return JSON.parse(payload);
}

function queueAirtableStateSave(appDb) {
  const serialized = JSON.stringify({
    ...appDb,
    airtable: {
      ...(appDb.airtable || {}),
      lastStateSaveError: ""
    }
  });
  airtableStateSaveChain = airtableStateSaveChain
    .then(() => saveSerializedDbToAirtableState(serialized))
    .then(() => {
      db.airtable ||= {};
      db.airtable.lastStateSaveAt = new Date().toISOString();
      db.airtable.lastStateSaveError = "";
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    })
    .catch((error) => {
      db.airtable ||= {};
      db.airtable.lastStateSaveError = error.message;
      console.warn(`Airtable state save failed: ${error.message}`);
    });
}

async function saveDbToAirtableState(appDb) {
  await saveSerializedDbToAirtableState(JSON.stringify(appDb));
}

async function saveSerializedDbToAirtableState(serialized) {
  const chunks = chunkString(serialized, AIRTABLE_STATE_CHUNK_SIZE);
  const existing = (await listAirtableRecords(AIRTABLE_TABLES.state))
    .filter((record) => record.fields?.Key === AIRTABLE_STATE_KEY)
    .sort((a, b) => Number(a.fields?.["Chunk Index"] || 0) - Number(b.fields?.["Chunk Index"] || 0));
  const creates = [];
  const updates = [];

  chunks.forEach((payload, index) => {
    const fields = {
      Key: AIRTABLE_STATE_KEY,
      "Chunk Index": index,
      Payload: payload
    };
    if (existing[index]) updates.push({ id: existing[index].id, fields });
    else creates.push({ fields });
  });

  await writeAirtableBatches(AIRTABLE_TABLES.state, "PATCH", updates);
  await writeAirtableBatches(AIRTABLE_TABLES.state, "POST", creates);
  await deleteAirtableRecords(AIRTABLE_TABLES.state, existing.slice(chunks.length).map((record) => record.id));
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

async function deleteAirtableRecords(tableName, recordIds) {
  for (const batch of chunk(recordIds, 10)) {
    if (!batch.length) continue;
    const params = new URLSearchParams();
    batch.forEach((recordId) => params.append("records[]", recordId));
    await airtableRequest(tableName, `?${params.toString()}`, { method: "DELETE" });
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

function chunkString(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
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
    createdAt: input.createdAt || new Date().toISOString(),
    source: cleanText(input.source),
    externalId: cleanText(input.externalId),
    mazevoStatus: cleanText(input.mazevoStatus),
    mazevoEventNumber: cleanText(input.mazevoEventNumber),
    mazevoBookingId: cleanText(input.mazevoBookingId),
    mazevoRoomDescription: cleanText(input.mazevoRoomDescription),
    mazevoBuildingDescription: cleanText(input.mazevoBuildingDescription),
    coverageBlocks: Array.isArray(input.coverageBlocks) ? input.coverageBlocks : [],
    importedAt: input.importedAt || ""
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
    createdAt: event.createdAt || new Date().toISOString(),
    source: cleanText(event.source),
    externalId: cleanText(event.externalId),
    mazevoStatus: cleanText(event.mazevoStatus),
    mazevoEventNumber: cleanText(event.mazevoEventNumber),
    mazevoBookingId: cleanText(event.mazevoBookingId),
    mazevoRoomDescription: cleanText(event.mazevoRoomDescription),
    mazevoBuildingDescription: cleanText(event.mazevoBuildingDescription),
    coverageBlocks: normalizeCoverageBlocks(event.coverageBlocks || []),
    importedAt: event.importedAt || ""
  };
  normalized.afterHours = isAfterHoursEvent(normalized);
  return normalized;
}

function normalizeCoverageBlocks(blocks = []) {
  return (blocks || [])
    .map((block) => ({
      id: cleanText(block.id) || `block-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      start: normalizeTimeValue(block.start, ""),
      end: normalizeTimeValue(block.end, ""),
      status: cleanText(block.status) || "requesting",
      workerId: cleanText(block.workerId),
      resolvedBy: cleanText(block.resolvedBy),
      resolvedAt: block.resolvedAt || "",
      note: cleanText(block.note)
    }))
    .filter((block) => block.start && block.end && minutes(block.end) > minutes(block.start));
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

function upsertStaffStatus(input, user) {
  db.staffStatuses ||= [];
  const record = createStaffStatusRecord(input, user);
  const existingIndex = db.staffStatuses.findIndex((item) =>
    item.date === record.date && staffStatusNameMatches(item.name, record.name)
  );
  if (existingIndex >= 0) {
    db.staffStatuses[existingIndex] = {
      ...db.staffStatuses[existingIndex],
      ...record,
      id: db.staffStatuses[existingIndex].id || record.id
    };
  } else {
    db.staffStatuses.push(record);
  }
  db.staffStatuses = cleanStaffStatusRecords(db.staffStatuses);
  return record;
}

function createStaffStatusRecord(input, user) {
  const name = staffStatusPersonName(input.name);
  if (!name) {
    const error = new Error("Choose one of the listed staff members.");
    error.status = 400;
    throw error;
  }
  const status = cleanText(input.status);
  if (!STAFF_STATUS_OPTIONS.includes(status)) {
    const error = new Error("Choose In Office, Remote, or Out of Office.");
    error.status = 400;
    throw error;
  }
  const space = status === "In Office" ? normalizeSpaceName(input.space) : "";
  if (status === "In Office" && (!space || space === "General")) {
    const error = new Error("Choose which space the staff member is in.");
    error.status = 400;
    throw error;
  }
  return {
    id: cleanText(input.id) || `staff-status-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    date: normalizeDateValue(input.date) || db.focusDate || FALLBACK_FOCUS_DATE,
    name,
    status,
    space,
    note: cleanText(input.note || input.notes).slice(0, 160),
    updatedAt: new Date().toISOString(),
    updatedBy: user.name
  };
}

function staffStatusesForDate(date) {
  const targetDate = normalizeDateValue(date) || db.focusDate || FALLBACK_FOCUS_DATE;
  return STAFF_STATUS_PEOPLE.map((name) => {
    const record = latestStaffStatusForPerson(targetDate, name);
    return publicStaffStatus(record || {
      id: "",
      date: targetDate,
      name,
      status: STAFF_STATUS_DEFAULT,
      space: "",
      note: "",
      updatedAt: "",
      updatedBy: ""
    });
  });
}

function latestStaffStatusForPerson(date, name) {
  return [...(db.staffStatuses || [])]
    .reverse()
    .find((item) => item.date === date && staffStatusNameMatches(item.name, name));
}

function publicStaffStatus(record) {
  return {
    id: record.id || "",
    date: record.date,
    name: record.name,
    status: record.status || STAFF_STATUS_DEFAULT,
    space: record.space || "",
    note: record.note || "",
    updatedAt: record.updatedAt || "",
    updatedBy: record.updatedBy || ""
  };
}

function staffStatusPersonName(value) {
  const clean = cleanText(value);
  return STAFF_STATUS_PEOPLE.find((name) => staffStatusNameMatches(name, clean)) || "";
}

function staffStatusNameMatches(left, right) {
  return cleanText(left).toLowerCase() === cleanText(right).toLowerCase();
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
  const candidates = coverageRequestCandidatesForEvent(event, appDb, options);
  const created = [];

  candidates.forEach((candidate) => {
    const exists = appDb.coverageRequests.some((request) =>
      request.eventId === event.id &&
      request.workerId === candidate.worker.id &&
      (request.coverageBlockId || "") === (options.coverageBlockId || "") &&
      (request.start || event.start) === (options.start || event.start) &&
      (request.end || event.end) === (options.end || event.end)
    );
    if (exists) return;
    appDb.coverageRequests.push({
      id: `request-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      eventId: event.id,
      coverageBlockId: options.coverageBlockId || "",
      workerId: candidate.worker.id,
      status: "pending",
      start: options.start || event.start,
      end: options.end || event.end,
      score: Math.min(100, Math.round(candidate.score)),
      reason: options.reason || candidate.reason,
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

function coverageRequestCandidatesForEvent(event, appDb, options = {}) {
  if (options.workerId) {
    const worker = appDb.workers.find((item) => item.id === options.workerId);
    return worker ? [scoreWorkerForScheduleNeed(worker, { ...event, start: options.start || event.start, end: options.end || event.end }, appDb)] : [];
  }
  const candidates = recommendWorkersForEvent({ ...event, start: options.start || event.start, end: options.end || event.end }, appDb);
  return spaceOwnerIdsForEvent(event, appDb).length ? candidates : candidates.slice(0, 1);
}

function ensureCoverageRequestsForFocusWeek(appDb) {
  appDb.events
    .filter((event) => event.afterHours && !afterHoursCoverageResolved(event) && isDateInFocusWeek(event.date, appDb.focusWeekStart))
    .forEach((event) => createCoverageRequestsForEvent(event, appDb, { silent: true }));
}

function ensureSharedOwnerCoverageRequests(appDb) {
  appDb.events
    .filter((event) => event.afterHours && !afterHoursCoverageResolved(event))
    .forEach((event) => {
      const ownerIds = spaceOwnerIdsForEvent(event, appDb);
      if (ownerIds.length < 2) return;

      coverageScopesForEvent(event).forEach((scope) => {
        const scopedRequests = appDb.coverageRequests.filter((request) => requestMatchesCoverageScope(request, event, scope));
        const acceptedRequest = scopedRequests.find((request) => ["accepted", "scheduled"].includes(request.status));
        const acceptedWorker = acceptedRequest ? appDb.workers.find((worker) => worker.id === acceptedRequest.workerId) : null;

        ownerIds.forEach((ownerId) => {
          if (scopedRequests.some((request) => request.workerId === ownerId)) return;
          const worker = appDb.workers.find((item) => item.id === ownerId);
          if (!worker) return;
          const scored = scoreWorkerForScheduleNeed(worker, { ...event, start: scope.start, end: scope.end }, appDb);
          appDb.coverageRequests.push({
            id: `request-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
            eventId: event.id,
            coverageBlockId: scope.coverageBlockId,
            workerId: ownerId,
            status: acceptedRequest ? "closed" : "pending",
            start: scope.start,
            end: scope.end,
            score: Math.min(100, Math.round(scored.score)),
            reason: acceptedRequest ? `Accepted by ${acceptedWorker?.name || "another student worker"}.` : scored.reason,
            createdAt: new Date().toISOString(),
            respondedAt: acceptedRequest?.respondedAt || ""
          });
        });
      });
    });
}

function coverageScopesForEvent(event) {
  const blocks = (event.coverageBlocks || []).filter((block) => !["covered", "scheduled", "rejected"].includes(block.status));
  if (!event.coverageBlocks?.length) {
    return [{ coverageBlockId: "", start: event.start, end: event.end }];
  }
  return blocks.map((block) => ({
    coverageBlockId: block.id || "",
    start: block.start || event.start,
    end: block.end || event.end
  }));
}

function requestMatchesCoverageScope(request, event, scope) {
  return request.eventId === event.id &&
    (request.coverageBlockId || "") === (scope.coverageBlockId || "") &&
    (request.start || event.start) === scope.start &&
    (request.end || event.end) === scope.end;
}

function afterHoursCoverageResolved(event) {
  if (event.coverageBlocks?.length) return eventCoverageComplete(event);
  return ["scheduled", "covered", "rejected"].includes(event.status);
}

function recommendWorkersForEvent(event, appDb) {
  const ownerIds = spaceOwnerIdsForEvent(event, appDb);
  if (ownerIds.length) {
    return ownerIds
      .map((ownerId) => appDb.workers.find((worker) => worker.id === ownerId))
      .filter(Boolean)
      .map((worker) => scoreWorkerForScheduleNeed(worker, event, appDb))
      .sort((a, b) => b.score - a.score || a.worker.name.localeCompare(b.worker.name));
  }
  return appDb.workers
    .map((worker) => scoreWorkerForScheduleNeed(worker, event, appDb))
    .filter((candidate) => candidate.score >= 20)
    .sort((a, b) => b.score - a.score || a.worker.name.localeCompare(b.worker.name));
}

function spaceOwnerIdsForEvent(event, appDb) {
  const configured = SPACE_OWNER_WORKER_IDS[event.space];
  const configuredIds = Array.isArray(configured) ? configured : configured ? [configured] : [];
  const ids = configuredIds.filter((ownerId) => appDb.workers.some((worker) => worker.id === ownerId));
  if (ids.length) return [...new Set(ids)];
  return appDb.workers.filter((worker) => worker.primarySpaces.includes(event.space)).map((worker) => worker.id);
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
    .filter((space) => space.name !== "WorldLabs Remote" && space.coverageRequired !== false)
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
          .filter(staffScheduleVisible)
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
  const breakStart = normalizeTimeValue(change.breakStart, "");
  const breakEnd = normalizeTimeValue(change.breakEnd, "");
  const slotIndex = Number(change.slotIndex);
  const date = normalizeDateValue(change.date) || (DAYS.includes(day) ? addDays(db.focusWeekStart, DAYS.indexOf(day)) : "");
  const originalSlot = Number.isInteger(slotIndex) && slotIndex >= 0 ? worker.availability[slotIndex] : null;

  if (!DAYS.includes(day) || minutes(end) <= minutes(start)) {
    throw new Error("Invalid schedule block");
  }
  if (mode === "split-day" && !(minutes(start) < minutes(breakStart) && minutes(breakStart) < minutes(breakEnd) && minutes(breakEnd) < minutes(end))) {
    const error = new Error("For split day, start must be before away start, away start before back time, and back time before end.");
    error.status = 400;
    throw error;
  }

  const before = worker.availability.length;
  const weekStart = date ? weekStartMonday(date) : db.focusWeekStart;
  const beforeHours = weeklyHoursFor(worker.availability, weekStart);
  let nextAvailability = [...worker.availability];
  if (mode === "replace-day") {
    nextAvailability = nextAvailability.filter((item) => !scheduleItemMatchesDate(item, day, date));
  }
  if (mode === "replace-space" || mode === "split-day") {
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
  const slotRanges = mode === "split-day"
    ? [[start, breakStart], [breakEnd, end]]
    : [[start, end]];
  slotRanges.forEach(([slotStart, slotEnd]) => {
    const nextSlot = slot(day, space, slotStart, slotEnd, change.source, date);
    applyBreakOverride(nextSlot, scheduleBreakMinutesFromChange(change, originalSlot, slotStart, slotEnd));
    nextAvailability.push(nextSlot);
  });
  nextAvailability.sort(sortScheduleSlots);

  const nextHours = weeklyHoursFor(nextAvailability, weekStart);
  if (nextHours > WEEKLY_HOUR_LIMIT) {
    const error = new Error(`${worker.name} would be scheduled for ${formatHourTotal(nextHours)} hours this week. Student workers must stay at or under ${WEEKLY_HOUR_LIMIT} hours, so edit or remove another block first.`);
    error.status = 400;
    throw error;
  }

  worker.availability = nextAvailability;

  const modeLabel = mode === "add" ? "added" : mode === "edit-slot" ? "edited" : mode === "split-day" ? "split" : "changed";
  const timeLabel = mode === "split-day"
    ? `${formatTime(start)}-${formatTime(breakStart)} and ${formatTime(breakEnd)}-${formatTime(end)}`
    : `${formatTime(start)}-${formatTime(end)}`;
  addAlert("warning", "Schedule changed", `${worker.name} ${modeLabel} ${space} on ${day}, ${timeLabel}. Weekly total: ${formatHourTotal(nextHours)}/${WEEKLY_HOUR_LIMIT} hours.`);
  addActivity(`${worker.name} ${modeLabel} schedule at ${space}; ${before} block${before === 1 ? "" : "s"} became ${worker.availability.length}, ${formatHourTotal(beforeHours)}h became ${formatHourTotal(nextHours)}h.`);
}

function weeklyHoursFor(availability, weekStart = db?.focusWeekStart || SOURCE_WEEK_START) {
  const spaces = db?.spaces || seedData.spaces;
  const hours = (availability || [])
    .filter((item) => scheduleItemInWeek(item, weekStart) && !scheduleItemOnClosedSpace(item, weekStart, spaces))
    .reduce((total, item) => total + paidHoursForScheduleItem(item), 0);
  return roundHours(hours);
}

function scheduleItemOnClosedSpace(item, weekStart, spaces) {
  const space = (spaces || []).find((spaceItem) => spaceItem.name === item.space);
  const date = item.date || (DAYS.includes(item.day) ? addDays(weekStart, DAYS.indexOf(item.day)) : "");
  return Boolean(date && isClosedDate(space, date));
}

function paidHoursForScheduleItem(item) {
  const durationMinutes = Math.max(0, minutes(item.end) - minutes(item.start));
  const breakMinutes = scheduleBreakMinutes(item, durationMinutes);
  return Math.max(0, durationMinutes - breakMinutes) / 60;
}

function scheduleBreakMinutes(item, durationMinutes = Math.max(0, minutes(item.end) - minutes(item.start))) {
  if (Number.isFinite(Number(item.unpaidBreakMinutes))) {
    return Math.max(0, Math.min(durationMinutes, Number(item.unpaidBreakMinutes)));
  }
  return durationMinutes >= LONG_SHIFT_BREAK_THRESHOLD_MINUTES ? DEFAULT_LONG_SHIFT_BREAK_MINUTES : 0;
}

function scheduleBreakMinutesFromChange(change, originalSlot, start, end) {
  const durationMinutes = Math.max(0, minutes(end) - minutes(start));
  if (change.noUnpaidBreak === true || cleanText(change.noUnpaidBreak) === "true" || cleanText(change.noUnpaidBreak) === "on") return 0;
  if (change.unpaidBreakMinutes !== undefined && change.unpaidBreakMinutes !== "") {
    const minutesValue = Number(change.unpaidBreakMinutes);
    if (Number.isFinite(minutesValue)) return Math.max(0, Math.min(durationMinutes, minutesValue));
  }
  if (change.preserveBreak !== false && originalSlot && originalSlot.unpaidBreakMinutes !== undefined) {
    return scheduleBreakMinutes(originalSlot, durationMinutes);
  }
  return scheduleBreakMinutes({ start, end }, durationMinutes);
}

function applyBreakOverride(slotItem, breakMinutes) {
  const defaultBreak = scheduleBreakMinutes({ start: slotItem.start, end: slotItem.end });
  if (breakMinutes !== defaultBreak) {
    slotItem.unpaidBreakMinutes = breakMinutes;
  }
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

function cleanSpaces(spaces = []) {
  return (spaces || []).filter((space) => !removedSpaceName(space.name));
}

function cleanEvents(events = []) {
  return (events || []).filter((event) => !removedSpaceName(event.space));
}

function cleanCoverageRequests(requests = [], events = []) {
  const eventIds = new Set((events || []).map((event) => event.id));
  return (requests || []).filter((request) => eventIds.has(request.eventId));
}

function removedSpaceName(name) {
  return REMOVED_SPACES.has(cleanText(name).toLowerCase());
}

function cleanStaffSchedules(schedules = []) {
  const seen = new Set();
  return (schedules || [])
    .filter(staffScheduleVisible)
    .filter((schedule) => {
      const key = [
        normalizeScheduleText(schedule.name),
        normalizeScheduleText(schedule.space),
        schedule.date || "",
        schedule.day || "",
        schedule.start || "",
        schedule.end || ""
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function cleanStaffStatusRecords(records = []) {
  const latestByPersonDate = new Map();
  (records || []).forEach((record) => {
    const name = staffStatusPersonName(record.name);
    const date = normalizeDateValue(record.date);
    if (!name || !date) return;
    const status = STAFF_STATUS_OPTIONS.includes(record.status) ? record.status : STAFF_STATUS_DEFAULT;
    const cleanRecord = {
      id: cleanText(record.id) || `staff-status-${date}-${slugify(name)}`,
      date,
      name,
      status,
      space: status === "In Office" ? normalizeSpaceName(record.space) : "",
      note: cleanText(record.note || record.notes).slice(0, 160),
      updatedAt: record.updatedAt || "",
      updatedBy: cleanText(record.updatedBy)
    };
    latestByPersonDate.set(`${date}|${name.toLowerCase()}`, cleanRecord);
  });
  return [...latestByPersonDate.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

function staffScheduleVisible(schedule = {}) {
  return !removedStaffScheduleName(schedule.name) && !copiedStudentCoverageSchedule(schedule);
}

function removedStaffScheduleName(name) {
  return ["lynn", "lynn romero"].includes(normalizeScheduleText(name));
}

function copiedStudentCoverageSchedule(schedule = {}) {
  const note = normalizeScheduleText(schedule.notes);
  return ["space coverage", "summer student coverage", "operations aide coverage"].includes(note) || String(schedule.id || "").startsWith("coverage-");
}

function normalizeScheduleText(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, " ");
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

startServer();

async function startServer() {
  db = await loadDbForRuntime();
  server.listen(PORT, () => {
    console.log(`Edson E+I Schedule Manager running at http://localhost:${PORT}`);
    console.log(`Storage mode: ${airtableBackendEnabled() ? `Airtable shared state (${AIRTABLE_TABLES.state})` : "local JSON"}`);
    if (!process.env.STAFF_PASSWORD || !process.env.STUDENT_DEFAULT_PASSWORD) {
      console.log("Default seed passwords are active. Set STAFF_PASSWORD and STUDENT_DEFAULT_PASSWORD before real deployment.");
    }
  });
}

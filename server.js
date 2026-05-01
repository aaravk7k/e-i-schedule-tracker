const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
const SOURCE_WEEK_START = "2026-04-20";
const FALLBACK_FOCUS_DATE = "2026-04-24";

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
  "Mesa": "#2454a6",
  "Fusion on First": "#7a3e9d",
  "The Studios": "#2f7d32",
  "WorldLabs Remote": "#344054",
  "General": "#667085"
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

function viewForUser(user) {
  const coverageGaps = getCoverageGaps();
  const currentUser = publicUser(user);
  const base = {
    currentUser,
    role: user.role,
    focusDate: db.focusDate,
    focusWeekStart: db.focusWeekStart,
    spaces: db.spaces,
    spaceColors: SPACE_COLORS,
    skillOptions: SKILL_OPTIONS,
    workers: db.workers.map((worker) => publicWorker(worker, user.role === "staff")),
    coverageGaps
  };

  if (user.role === "staff") {
    return {
      ...base,
      tasks: db.tasks,
      alerts: buildAlerts(coverageGaps),
      activity: db.activity,
      users: db.users.map(publicUser),
      airtable: airtableStatus()
    };
  }

  return {
    ...base,
    tasks: db.tasks.filter((task) => task.assignedTo === user.workerId),
    alerts: coverageGaps.slice(0, 8).map(gapToAlert)
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
  return {
    id: worker.id,
    name: worker.name,
    role: worker.role,
    initials: worker.initials,
    supervisor: forStaff ? worker.supervisor : "",
    primarySpaces: worker.primarySpaces,
    skills: worker.skills,
    availability: worker.availability
  };
}

function buildAlerts(gaps) {
  const gapAlerts = gaps.slice(0, 10).map(gapToAlert);
  return [...gapAlerts, ...(db.alerts || []).slice(0, 8)];
}

function gapToAlert(gap) {
  return {
    level: "warning",
    title: `${gap.space} has an uncovered time`,
    message: `${formatShortDate(gap.date)} from ${gap.detail}. ${gap.blocks.length ? `Other scheduled blocks that day: ${gap.blocks.join(", ")}.` : "No one is scheduled at that space that day."}`
  };
}

function createInitialDb() {
  const initial = {
    focusDate: FALLBACK_FOCUS_DATE,
    focusWeekStart: SOURCE_WEEK_START,
    spaces: structuredClone(seedSpaces),
    workers: structuredClone(seedWorkers),
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

  sourceTaskTemplates.forEach((template, index) => {
    const task = normalizeTemplateTask(template, index, initial.focusDate);
    assignTask(task, initial, { honorPreferred: true });
    initial.tasks.push(task);
  });

  coverageTaskTemplates.forEach((template, index) => {
    const task = normalizeTemplateTask(template, index + 100, initial.focusDate);
    assignTask(task, initial, { honorPreferred: false });
    initial.tasks.push(task);
  });

  initial.tasks.sort(sortTasks);
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
  appDb.focusDate ||= FALLBACK_FOCUS_DATE;
  appDb.focusWeekStart ||= SOURCE_WEEK_START;
  appDb.activity ||= [];
  appDb.alerts ||= [];
  appDb.airtable ||= {};
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

function getCoverageGaps() {
  const gaps = [];
  db.spaces
    .filter((space) => space.name !== "WorldLabs Remote")
    .forEach((space) => {
      DAYS.forEach((day, dayIndex) => {
        const hours = space.hours[day];
        if (!hours) return;
        const date = addDays(db.focusWeekStart, dayIndex);
        const open = minutes(hours[0]);
        const close = minutes(hours[1]);
        const allBlocks = db.workers.flatMap((worker) =>
          worker.availability
            .filter((slotItem) => slotItem.day === day && slotItem.space === space.name)
            .map((slotItem) => ({
              start: minutes(slotItem.start),
              end: minutes(slotItem.end),
              label: `${worker.name} ${formatTime(slotItem.start)}-${formatTime(slotItem.end)}`
            }))
        );
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

  if (!DAYS.includes(day) || minutes(end) <= minutes(start)) {
    throw new Error("Invalid schedule block");
  }

  const before = worker.availability.length;
  if (mode === "replace-day") {
    worker.availability = worker.availability.filter((item) => item.day !== day);
  }
  if (mode === "replace-space") {
    worker.availability = worker.availability.filter((item) => !(item.day === day && item.space === space));
  }
  worker.availability.push(slot(day, space, start, end));
  worker.availability.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || minutes(a.start) - minutes(b.start));

  const modeLabel = mode === "add" ? "added" : "changed";
  addAlert("warning", "Schedule changed", `${worker.name} ${modeLabel} ${space} on ${day}, ${formatTime(start)}-${formatTime(end)}.`);
  addActivity(`${worker.name} ${modeLabel} schedule at ${space}; ${before} block${before === 1 ? "" : "s"} became ${worker.availability.length}.`);
}

function addAlert(level, title, message) {
  db.alerts ||= [];
  db.alerts.unshift({
    id: `alert-${Date.now()}-${db.alerts.length}`,
    level,
    title,
    message,
    at: new Date().toISOString()
  });
  db.alerts = db.alerts.slice(0, 25);
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

function slot(day, space, start, end) {
  return { day, space, start, end, source: "Staff and Space Schedule, Apr 20-26 2026" };
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
  const exact = db?.spaces?.find((space) => space.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.name;
  const source = db?.spaces || seedSpaces;
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

function minutes(time) {
  const [hours, mins] = String(time || "00:00").split(":").map(Number);
  return hours * 60 + mins;
}

function overlap(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
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

const seedSpaces = [
  { id: "1951", name: "1951@SkySong", campus: "SkySong", hours: { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Wednesday: ["08:00", "17:00"], Thursday: ["08:00", "17:00"], Friday: ["08:00", "17:00"] } },
  { id: "850pbc", name: "850PBC", campus: "Downtown Phoenix", hours: { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Wednesday: ["08:00", "17:00"], Thursday: ["08:00", "17:00"], Friday: ["08:00", "17:00"] } },
  { id: "acic", name: "ACIC", campus: "Tempe", hours: { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Wednesday: ["08:00", "17:00"], Thursday: ["08:00", "17:00"], Friday: ["08:00", "17:00"] } },
  { id: "mesa", name: "Mesa", campus: "Media and Immersive eXperience Center", hours: { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Wednesday: ["08:00", "17:00"], Thursday: ["08:00", "17:00"], Friday: ["08:00", "17:00"], Saturday: ["08:30", "16:30"] } },
  { id: "fusion", name: "Fusion on First", campus: "Downtown Phoenix", hours: { Wednesday: ["16:00", "22:00"], Thursday: ["16:00", "22:00"], Friday: ["16:00", "22:00"] } },
  { id: "studios", name: "The Studios", campus: "Tempe", hours: { Monday: ["09:00", "17:00"], Tuesday: ["09:00", "17:00"], Wednesday: ["09:00", "17:00"], Thursday: ["09:00", "17:00"], Friday: ["09:00", "17:00"] } },
  { id: "worldlabs", name: "WorldLabs Remote", campus: "Online", hours: { Monday: ["08:00", "17:00"], Tuesday: ["08:00", "17:00"], Wednesday: ["08:00", "17:00"], Thursday: ["08:00", "17:00"], Friday: ["08:00", "17:00"] } }
];

const seedWorkers = [
  { id: "aarav-kapoor", name: "Aarav Kapoor", role: "Student Worker", initials: "AK", supervisor: "Dania Alcala-Calvillo", primarySpaces: ["1951@SkySong", "WorldLabs Remote", "General"], skills: ["worldlabs", "data", "coverage", "operations", "administrative", "communications", "customer-service"], availability: [slot("Monday", "1951@SkySong", "12:30", "17:00"), slot("Tuesday", "1951@SkySong", "14:00", "17:00"), slot("Wednesday", "1951@SkySong", "12:30", "17:00"), slot("Friday", "1951@SkySong", "09:00", "17:00")] },
  { id: "sakshi-katargamwala", name: "Sakshi Ritesh Katargamwala", role: "Student Worker", initials: "SRK", supervisor: "Matthew Kohlbeck", primarySpaces: ["850PBC", "WorldLabs Remote"], skills: ["worldlabs", "coverage", "operations", "administrative", "customer-service"], availability: [slot("Monday", "850PBC", "13:00", "17:00"), slot("Tuesday", "850PBC", "08:00", "11:00"), slot("Wednesday", "850PBC", "13:00", "17:00"), slot("Friday", "850PBC", "08:00", "17:00")] },
  { id: "daksh-preetha", name: "Daksh Preetha", role: "Student Worker", initials: "DP", supervisor: "Sarah Zarr", primarySpaces: ["Mesa", "850PBC", "Event Coverage"], skills: ["events", "coverage", "operations", "customer-service"], availability: [slot("Tuesday", "850PBC", "16:00", "19:00"), slot("Friday", "Mesa", "08:00", "17:00"), slot("Saturday", "Mesa", "08:30", "16:30")] },
  { id: "aditya-patil", name: "Aditya Patil", role: "Student Worker", initials: "AP", supervisor: "Sarah Zarr", primarySpaces: ["ACIC", "WorldLabs Remote"], skills: ["worldlabs", "coverage", "events", "graphic-design", "communications"], availability: [slot("Monday", "ACIC", "08:00", "13:00"), slot("Tuesday", "ACIC", "08:00", "13:00"), slot("Wednesday", "ACIC", "08:00", "13:00")] },
  { id: "mitchell-tecun", name: "Mitchell Tecun", role: "Student Worker", initials: "MT", supervisor: "Sarah Zarr", primarySpaces: ["ACIC", "WorldLabs Remote"], skills: ["worldlabs", "coverage", "events", "data", "graphic-design", "communications"], availability: [slot("Tuesday", "ACIC", "13:00", "17:00"), slot("Wednesday", "ACIC", "13:00", "17:00"), slot("Thursday", "ACIC", "08:00", "12:00"), slot("Friday", "ACIC", "11:00", "17:00")] }
];

const sourceTaskTemplates = [
  { title: "Prompt: Share something new you learned this week.", category: "WorldLabs Post", sourceDate: "2025-10-01", sourceAssignee: "Aarav", group: "General E+I", dueOffset: 0, window: ["10:00", "16:00"], priority: "Normal" },
  { title: "Save the Date: Pitch In is next week", category: "WorldLabs Post", sourceDate: "2025-10-01", sourceAssignee: "", group: "Pitch In", dueOffset: 0, window: ["10:00", "16:00"], priority: "High" },
  { title: "Save the Date: Coffee + Co-Working", category: "WorldLabs Post", sourceDate: "2025-10-01", sourceAssignee: "", group: "General E+I", dueOffset: 1, window: ["10:00", "16:00"], priority: "Normal" },
  { title: "Launch: Monthly Bingo Card", category: "WorldLabs Post", sourceDate: "2025-10-02", sourceAssignee: "Mitchell", group: "General E+I", dueOffset: 2, window: ["09:00", "14:00"], priority: "Normal", requiredSkills: ["graphic-design", "communications"] },
  { title: "Prompt: Celebrate a tiny win with us today.", category: "WorldLabs Post", sourceDate: "2025-10-03", sourceAssignee: "Aarav", group: "Chandler Endeavor", dueOffset: 0, window: ["11:00", "16:00"], priority: "Normal" },
  { title: "Chandler Endeavor weekly WorldLabs post", category: "WorldLabs Post", sourceDate: "2025-10-07", sourceAssignee: "Aditya", group: "Chandler Endeavor", dueOffset: 4, window: ["09:00", "13:00"], priority: "Normal" },
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
  { title: "Mesa weekday coverage", category: "On-site Coverage", space: "Mesa", dueOffset: 0, window: ["08:00", "17:00"], priority: "Normal", source: "Staff and Space Schedule" },
  { title: "ASU event coverage at 1951", category: "Event Coverage", space: "1951@SkySong", dueOffset: 0, window: ["17:00", "19:30"], priority: "Urgent", source: "After Hour Events" },
  { title: "Mesa weekend coverage", category: "On-site Coverage", space: "Mesa", dueOffset: 1, window: ["08:30", "16:30"], priority: "High", source: "Staff and Space Schedule" },
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

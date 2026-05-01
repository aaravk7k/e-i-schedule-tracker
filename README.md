# Edson E+I TaskOps

Deployable web app for Edson E+I student-worker schedules, skills, task assignment, event coverage, and space coverage alerts.

## What It Does

- Staff login and student login are separate.
- Staff can create tasks, paste event lists, add students, edit schedules, generate WorldLabs tasks, and rerun assignment.
- Students can only see their own tasks, update their skills, update their own schedule, and view shared schedules/spaces.
- Tasks are assigned by availability, space, workload, and skills such as Administrative, Graphic Design, Communications, Front Desk, Event Coverage, WorldLabs, and Data + Reporting.
- Coverage alerts use plain language, for example: `1951@SkySong has an uncovered time: Apr 24 from 8:00AM-9:00AM. Other scheduled blocks that day: Aarav Kapoor 9:00AM-5:00PM.`
- Staff can push current Tasks, Students, Schedules, and Spaces into Airtable when Airtable environment variables are configured.

## Run Locally

```bash
npm start
```

Open:

```text
http://localhost:8787
```

Default local demo accounts:

```text
Staff: staff@ei.asu.edu / edson-staff
Student: aarav-kapoor@ei.asu.edu / edson-student
```

## Deploy

This app uses only Node.js built-in modules, so there is no install step beyond having Node 18+.

Recommended environment variables:

```text
NODE_ENV=production
PORT=8787
STAFF_EMAIL=your-staff-email@asu.edu
STAFF_PASSWORD=change-this-password
STUDENT_DEFAULT_PASSWORD=change-this-too
DATA_DIR=/data
AIRTABLE_PAT=pat_your_token_here
AIRTABLE_BASE_ID=app_your_base_id_here
AIRTABLE_TABLE_TASKS=Tasks
AIRTABLE_TABLE_STUDENTS=Students
AIRTABLE_TABLE_SCHEDULES=Schedules
AIRTABLE_TABLE_SPACES=Spaces
```

For Render, Railway, Fly.io, or similar:

1. Create a new Node web service from this folder/repo.
2. Set the start command to `npm start`.
3. Set the environment variables above.
4. Add a persistent disk/volume and point `DATA_DIR` at that disk path.
5. Deploy.

The app saves live data to `data/db.json` by default. For real workplace use, make sure `DATA_DIR` is on persistent storage so schedules and tasks do not reset when the service restarts.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Docker and production rollout notes.

## Airtable Setup

Create these Airtable tables:

- `Tasks`
- `Students`
- `Schedules`
- `Spaces`

Add a text field named `External ID` to every table. The app uses that field to update existing Airtable records instead of creating duplicates on every sync.

The default table names can be changed with the `AIRTABLE_TABLE_*` environment variables above. The Airtable token must stay server-side in `AIRTABLE_PAT`; never paste it into browser code.

## Event List Format

Paste one event per line:

```text
Pitch In | 2026-04-24 | 1951@SkySong | 5:00PM | 7:30PM | Front Desk, Event Coverage
PBIS Workshop | 2026-04-25 | 850PBC | 9:00AM | 12:00PM | Administrative, Event Coverage
```

## Important Next Step

Before using this with everyone at work, change the default passwords with environment variables. The local demo passwords are only for testing.

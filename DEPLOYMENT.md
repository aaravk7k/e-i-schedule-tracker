# Deployment Guide

## Best Department-Ready Path

For real use at ASU, the cleanest path is:

1. Put this project in a private GitHub repo owned by the department or ASU.
2. Ask ASU/department IT where Node apps should be hosted.
3. Deploy the app to that approved host.
4. Set production environment variables.
5. Use persistent storage for `DATA_DIR`.
6. Replace demo passwords with real staff/student accounts or ASU SSO.

## Production Environment Variables

```text
NODE_ENV=production
PORT=8787
STAFF_EMAIL=your-supervisor-email@asu.edu
STAFF_PASSWORD=make-a-strong-password
STUDENT_DEFAULT_PASSWORD=make-a-temporary-student-password
STUDENT_WEEKLY_HOUR_LIMIT=20
DATA_DIR=/data
AIRTABLE_BACKEND=true
AIRTABLE_PAT=pat_your_token_here
AIRTABLE_BASE_ID=app_your_sandbox_base_id
AIRTABLE_TABLE_STATE=Schedule Manager State
```

## Important Data Note

The app currently stores live data in JSON at:

```text
data/db.json
```

That is fine for a pilot. For department-wide use, either:

- mount persistent storage and set `DATA_DIR=/data`, or
- set `AIRTABLE_BACKEND=true` and use a sandbox Airtable base as the shared state store.
- move the storage layer to PostgreSQL/Supabase/Firebase later if IT wants a traditional database.

Do not deploy it on a platform without persistent storage unless it is only a short demo.

## Airtable Shared Pilot

For Level 2 testing, create a separate Airtable sandbox base. Do not use the live department project-management base yet.

Create one table:

```text
Schedule Manager State
```

Add these fields:

```text
Key - single line text
Chunk Index - number
Payload - long text
Updated At - single line text or date
```

Then create an Airtable personal access token with access to only that sandbox base. Use the `data.records:read` and `data.records:write` scopes. The app stores the schedule manager state in chunks inside that table, so everyone on the deployed URL sees the same schedules, coverage requests, and login records.

This is a pilot backend, not final ASU production security. For real rollout, ask IT about ASU SSO, approved hosting, backups, and audit requirements.

## Docker Deploy

Build:

```bash
docker build -t edson-ei-schedule-manager .
```

Run:

```bash
docker run -p 8787:8787 \
  -e STAFF_EMAIL=your-supervisor-email@asu.edu \
  -e STAFF_PASSWORD=make-a-strong-password \
  -e STUDENT_DEFAULT_PASSWORD=make-a-temporary-student-password \
  -e DATA_DIR=/data \
  -v schedule-manager-data:/data \
  edson-ei-schedule-manager
```

Open:

```text
http://localhost:8787
```

## Pilot Host Options

Good pilot options:

- Azure App Service if ASU already supports Azure.
- Render/Railway if you need a very quick demo and your department approves it.
- Fly.io if you want Docker-based deployment with a persistent volume.

For actual department use, choose whatever ASU IT approves first.

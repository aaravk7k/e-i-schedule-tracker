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
DATA_DIR=/data
```

## Important Data Note

The app currently stores live data in JSON at:

```text
data/db.json
```

That is fine for a pilot. For department-wide use, either:

- mount persistent storage and set `DATA_DIR=/data`, or
- move the storage layer to PostgreSQL/Supabase/Firebase later.

Do not deploy it on a platform without persistent storage unless it is only a short demo.

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

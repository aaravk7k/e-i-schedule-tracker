# Edson E+I Schedule Manager

Deployable web app for Edson E+I student-worker schedules, space coverage, skills, and coverage-gap alerts.

## What It Does

- Staff login and student login are separate.
- Staff can add students, edit weekly student-worker schedules, view staff schedules, add events, and see space business hours.
- Students can update their own availability, update their skills, and view shared schedules/spaces.
- Coverage alerts point out gaps by space and time, for example: `Gap: 1951@SkySong. No coverage on Apr 24 from 11:00AM-5:00PM.`
- After-hours events automatically create coverage requests for the best-fit student workers from that space.
- Students can accept or deny coverage requests. If they accept, they can add the event directly to their schedule and supervisors get an alert.
- Skills are tracked so scheduling can recommend students by space, schedule, and coverage/event skill.

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
```

For Render, Railway, Fly.io, or similar:

1. Create a new Node web service from this folder/repo.
2. Set the start command to `npm start`.
3. Set the environment variables above.
4. Add a persistent disk/volume and point `DATA_DIR` at that disk path.
5. Deploy.

The app saves live data to `data/db.json` by default. For real workplace use, make sure `DATA_DIR` is on persistent storage so schedules do not reset when the service restarts.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Docker and production rollout notes.

## Meeting Demo Focus

Use the `schedule-manager` branch to show:

- separate staff and student sign-ins
- the shared weekly schedule board
- coverage-gap alerts when a space is open with no student scheduled
- staff schedules alongside student schedules
- after-hours event coverage requests
- student accept/deny and add-to-schedule flow
- staff schedule edits
- student self-service availability updates
- space business hours

## Important Next Step

Before using this with everyone at work, change the default passwords with environment variables. The local demo passwords are only for testing.

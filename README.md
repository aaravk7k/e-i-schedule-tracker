# Edson E+I Schedule Manager

Deployable web app for Edson E+I student-worker schedules, space coverage, skills, and coverage-gap alerts.

## What It Does

- Starts with the PBIS Schedule for May 25-May 31, 2026, plus imported May, June, and July booking exports.
- June and July use a simple summer rule: space owners are scheduled at their primary spaces, with Aarav on SkySong operations coverage from 9:00AM-5:00PM and 1951@SkySong covered from 8:00AM-5:00PM.
- Staff login and student login are separate.
- Staff can create extra staff/student test logins from the Access page.
- Staff can add students, edit weekly student-worker schedules, view staff schedules, add events, and see space business hours.
- Students can update their own availability, update their skills, and view shared schedules/spaces.
- Coverage alerts point out gaps by space and time if business-hour coverage is missing.
- After-hours events automatically create a coverage request for the student managing that space.
- Students can accept or deny coverage requests. If they accept, they can add the event directly to their schedule only if it keeps them under the configured weekly hour limit.
- If an after-hours request would push a student over the weekly limit, the app sends them to edit/remove schedule blocks before adding it.
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
STUDENT_WEEKLY_HOUR_LIMIT=40
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
- the shared weekly coverage board
- the automatic `Needs Attention` panel
- PBIS student schedules, staff schedules, and space coverage together
- May, June, and July imported bookings on the `Bookings` page
- after-hours event requests that get sent to students for the selected week
- student accept/deny, weekly hour cap, edit-hours, and add-to-schedule flow
- space business hours

## Important Next Step

Before using this with everyone at work, change the default passwords with environment variables. The local demo passwords are only for testing.

For a department pilot, use temporary test passwords and share access only with the people testing the app. For long-term use, the clean version should go through IT with ASU SSO or another approved login system.

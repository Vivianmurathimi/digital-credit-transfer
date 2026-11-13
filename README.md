# PTE Credit Transfer

Students apply to have courses from another university recognised for a PTE course; the
programme's reviewers decide (a main reviewer, and extra reviewers while allowed to assist); the
programme's committee then keeps or changes each decision, and the student learns the final result;
the admin manages semesters, access, domains and students.
`backend/` is the Express API (PostgreSQL, MinIO), `frontend/` the React app.
More detail on the reviewer side: [backend/REVIEWER.md](backend/REVIEWER.md).

## Before a migration: back up the database

Some migrations convert and then drop old columns (e.g. 016, the semester times). Each migration
runs in one transaction and checks its row counts, but always take a backup first. From the
project folder, with the database in the Docker container `credit_system_db`:

```
docker exec credit_system_db pg_dump -U user -Fc credit_db > backup-credit_db-$(date +%Y%m%d-%H%M).dump
```

(Without Docker: `pg_dump -h localhost -U <DB_USER> -Fc <DB_NAME> > backup.dump`, values from
`backend/.env`.) Backups (`*.dump`) are ignored by Git. To restore one:

```
docker exec -i credit_system_db pg_restore -U user -d credit_db --clean --if-exists < backup-credit_db-YYYYMMDD-HHMM.dump
```

## Running it

From `backend`:

```
npm run migrate      # apply the database migrations (safe to run any time)
node server.js       # the backend on the development database (DB_NAME in backend/.env)
```

From `frontend`: `npm start` (http://localhost:3000).

Only one backend can use the port at a time: stop `node server.js` before `npm run demo:start`, and the other way round.

## Demo logins

`npm run demo:seed` (re)creates the separate demo database and buckets; `npm run demo:start` starts the
backend on them. Both refuse to run with `NODE_ENV=production`. Password for every account: `Demo1234!`

| Role | Login |
|---|---|
| Admin | `demo.admin@staff.example` |
| Main reviewer, Computer Science | `demo.reviewer.cs@staff.example` (Dr. Katalin Szabó) |
| Main reviewer, Civil Engineering | `demo.reviewer.civil@staff.example` (Dr. Péter Horváth) |
| Extra reviewer, Computer Science (assisting: sees CS) | `demo.extra.cs@staff.example` (Dr. Gergely Balogh) |
| Extra reviewer, Civil Engineering (standby: sees nothing) | `demo.extra.civil@staff.example` (Dr. Réka Fehér) |
| Committee member, both programmes | `demo.committee@staff.example` (Prof. Judit Lakatos) |
| Committee member, Computer Science | `demo.committee.cs@staff.example` (Prof. András Takács) |
| Students, Computer Science | `demo.anna@`, `demo.bence@`, `demo.csilla@`, `demo.daniel@` … `students.example` |
| Students, Civil Engineering | `demo.eszter@`, `demo.ferenc@`, `demo.gabor@` … `students.example` |

The demo has applications awaiting the committee (Dániel), kept by it (Ferenc), changed from approved to
rejected (Anna, CS401) and from rejected to approved with a grade (Eszter).

The demo logins only work while the **demo** backend runs (`npm run demo:start`), not with `node server.js`.

## Development test accounts

`npm run seed:dev` adds test data to the development database (refused with `NODE_ENV=production`).
Password: `Test1234!`. Accounts that would clash with existing data (same email or Neptun code, or a
programme that already has a main reviewer) are skipped, and the test admin is only created when
there is no active admin yet, so an existing database keeps its accounts.

| Role | Login |
|---|---|
| Admin | `admin@staff.example` |
| Reviewers | `reviewer.cs@staff.example`, `reviewer.civil@staff.example` |
| Committee | `committee@staff.example` (both programmes), `committee.cs@staff.example` (Computer Science) |
| Students | `student.cs@students.example`, `student.civil@students.example` |

## Email domains

No email domain is written in the code. Students can register only from a domain on the admin's
**Allowed email domains** list; reviewers and admins are invited (Staff access). The demo and test
data use `students.example` and `staff.example`, names reserved for examples that can never be real;
the seed and demo scripts put `students.example` on the list themselves.
`npm run check:domains` (from `backend`) proves that no real domain is left in the repository.

## The first admin

On a new installation, with no active admin yet (from `backend`):

```
npm run make-superadmin -- someone@your-university.example
```

(or set `FIRST_ADMIN_EMAIL`). It prints an invite link; opening it, the person sets their name and
password. After that, admins invite each other from the dashboard.

## Checks

From `backend`: `npm test`, `npm run security-check` (with the backend running), `npm run check:domains`.
From `frontend`: `npm run check:translations`, `npm run check:missing-keys`, `npm run check:contrast`, `npm run check:form-rules`,
`npm run check:reviewer-list`, `npm run check:admin-menu`, `CI=true npm test`, `npm run build`.

Colours: the app's colours live only in `frontend/src/theme/theme.css` (`check:contrast` refuses a colour
written in a component and checks every text pair for WCAG AA). The emails and the PDF book use
`backend/utils/brandColors.js`, which must be changed together with `theme.css`; the backend `npm test`
fails when the two differ.

## The admin menu

Admins land on `/admin` (Overview). Each area has its own address: `/admin/semesters`,
`/admin/late-access`, `/admin/catalogue`, `/admin/applications`, `/admin/past-semesters`, `/admin/analytics`, `/admin/reviewers`, `/admin/committee`,
`/admin/students`, `/admin/admins`, `/admin/domains`.

## The semester timeline

Several semesters can be in progress at once: the next one's application period may open while the
previous one is still being reviewed; application periods never overlap. Whether students can
register or submit is decided only by the application period (`backend/utils/applicationPeriod.js`):
its times, Close now / Reopen until, and late access (which submits into its own semester). Each
semester has a **review deadline** (default: applications close + 14 days): a target, nothing is
rejected when it passes; reviewers are reminded before it and the admins are told after it. The
semester's last day is a label only. The admin closes a semester (Semester) once its application
period is over, no late access runs and everything is decided; it is then read-only and listed under
Past semesters. Reviewers get one daily summary email at 07:00 Budapest time instead of an email per
application. After a reviewer decides, the application **awaits the committee**; the committee has its
own **committee deadline** (default: review deadline + 14 days, also a target), its own daily summary
and reminders, and a semester closes only when nothing awaits it. More: [backend/REVIEWER.md](backend/REVIEWER.md), section 9.

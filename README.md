# PTE Credit Transfer

Students apply to have courses from another university recognised for a PTE course; the
programme's reviewer decides; the admin manages access, domains and students.
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
| Reviewer, Computer Science | `demo.reviewer.cs@staff.example` (Dr. Katalin Szabó) |
| Reviewer, Civil Engineering | `demo.reviewer.civil@staff.example` (Dr. Péter Horváth) |
| Students, Computer Science | `demo.anna@`, `demo.bence@`, `demo.csilla@`, `demo.daniel@` … `students.example` |
| Students, Civil Engineering | `demo.eszter@`, `demo.ferenc@`, `demo.gabor@` … `students.example` |

The demo logins only work while the **demo** backend runs (`npm run demo:start`), not with `node server.js`.

## Development test accounts

`npm run seed:dev` adds test data to the development database (refused with `NODE_ENV=production`).
Password: `Test1234!`. Accounts that would clash with existing data (same email or Neptun code, or a
programme that already has an active reviewer) are skipped, and the test admin is only created when
there is no active admin yet, so an existing database keeps its accounts.

| Role | Login |
|---|---|
| Admin | `admin@staff.example` |
| Reviewers | `reviewer.cs@staff.example`, `reviewer.civil@staff.example` |
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
From `frontend`: `npm run check:translations`, `npm run check:contrast`, `npm run check:form-rules`,
`npm run check:reviewer-list`, `npm run check:admin-menu`, `CI=true npm test`, `npm run build`.

## The admin menu

Admins land on `/admin` (Overview). Each area has its own address: `/admin/semesters`,
`/admin/late-access`, `/admin/catalogue`, `/admin/applications`, `/admin/past-semesters`, `/admin/reviewers`,
`/admin/students`, `/admin/admins`, `/admin/domains`. Whether students can register or submit is
decided only by the active semester's dates, Close now / Reopen until, and late access. A semester is
closed only by the admin (Semester, after its last day); it is then read-only and listed under Past semesters.

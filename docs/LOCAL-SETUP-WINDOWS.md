# Local setup on Windows

What was done to run TCMS on a Windows 11 machine (2026-10-15). Commands run in
Git Bash from the repository root.

## 1. Prerequisites

- Node 24, npm 11, bun.
- MySQL 8.4 on `127.0.0.1:5500`, schema `tcms_test`, time zone `+00:00`.
- **Never connect to port 3306** — on this machine that is a different MySQL 8.0
  server, not TCMS.
- Three database users (passwords are not stored in this repository):

| User | Rights | Used by |
|---|---|---|
| `tcms_app` | data only (DML) | `DATABASE_URL` — the app at runtime |
| `tcms_migrate` | can change tables (DDL) | `DIRECT_URL` — `prisma migrate deploy` only |
| `tcms_backup` | read-only | `BACKUP_DATABASE_URL` — backups |

## 2. `.env`

Copy `.env.example` to `.env` (git-ignored) and set:

```
DATABASE_URL=mysql://tcms_app:<password>@127.0.0.1:5500/tcms_test?connection_limit=20&pool_timeout=10
DIRECT_URL=mysql://tcms_migrate:<password>@127.0.0.1:5500/tcms_test
BACKUP_DATABASE_URL=mysql://tcms_backup:<password>@127.0.0.1:5500/tcms_test
JWT_SECRET=<fresh random value, 32+ characters>
WS_NOTIFY_SECRET=<fresh random value>
TCMS_ENABLE_SEED=true
TCMS_ALLOW_SIGNUP=true
NEXT_PUBLIC_ALLOW_SIGNUP=true
```

Percent-encode special characters in passwords (for example `@` → `%40`).

## 3. Install

```
npm install
```

npm 11 blocks package install scripts unless they are approved. The required ones
are approved in `package.json` → `allowScripts` (`@prisma/client`, `@prisma/engines`,
`prisma`, `sharp`, `unrs-resolver`), via `npm install-scripts approve <pkg>`.

## 4. Database schema

```
npx prisma generate
npx prisma migrate deploy
```

Applies the versioned migrations in `prisma/migrations/` as the `DIRECT_URL` user.

## 5. Run and seed

```
npm run dev
```

The app serves http://localhost:3000. With `TCMS_ENABLE_SEED=true`, seed demo data
once (a no-op when any user already exists):

```
curl -X POST -H "Origin: http://localhost:3000" http://localhost:3000/api/seed
```

Demo logins are created by `src/app/api/seed/seed.service.ts` (for example
`admin@tcms.com`). Local machine only — never seed a shared or production database.

# 🚀 TCMS — Complete Online Deployment Guide

> **Who this guide is for:** anyone deploying this project for the very first time. Every step tells you exactly what to click, what to type, and what you should see.
>
> **What you will achieve:** your TCMS (Test Case Management System) running live on the internet at a link like `https://tcms-xxxx.vercel.app` that you and your team can open in any browser — **without installing anything on your computer**. No Node.js, no PostgreSQL, no Docker, no terminal commands are required for the main path.
>
> **Everything you need** is three free accounts:

> ⚠️ **HISTORICAL (2026-10-14): this guide predates the MySQL migration.** It walks
> through Neon (free PostgreSQL) + Vercel + pgAdmin — that stack no longer applies:
> TCMS is **MySQL 8.4-only** now. For the current path see `docs/migration/`
> (migration + cutover) and `docs/17-operations-runbook.md` (operations). This guide
> will be rewritten for the company MySQL server once IT provides host/port/TEST
> schema/credentials (request: `download/it-request-mysql.md`).

| Account | What it provides | Sign up at |
|---|---|---|
| **Neon** | Free cloud PostgreSQL database | https://neon.tech |
| **GitHub** | Free code hosting (Vercel pulls the code from here) | https://github.com |
| **Vercel** | Free hosting that runs the Next.js app | https://vercel.com |

> 💡 All three support **"Sign up with GitHub"** — create the GitHub account first, then use it to sign in to Neon and Vercel. This saves you juggling multiple logins.

---

## 📚 Table of Contents

- [Part 0 · How the pieces fit together](#part-0--how-the-pieces-fit-together)
- [Part 1 · Create the free database on Neon](#part-1--create-the-free-database-on-neon)
- [Part 2 · Create the tables (paste one file — 2 minutes)](#part-2--create-the-tables-paste-one-file--2-minutes)
- [Part 3 · Put the code on GitHub](#part-3--put-the-code-on-github)
- [Part 4 · Deploy to Vercel](#part-4--deploy-to-vercel)
- [Part 5 · Activate your app and log in](#part-5--activate-your-app-and-log-in)
- [Part 6 · Optional — browse the database with pgAdmin 4](#part-6--optional--browse-the-database-with-pgadmin-4)
- [Part 7 · Daily use, limits and updates](#part-7--daily-use-limits-and-updates)
- [Part 8 · Troubleshooting FAQ](#part-8--troubleshooting-faq)
- [Appendix A · Connection string cheat sheet](#appendix-a--connection-string-cheat-sheet)
- [Appendix B · What was changed during the PostgreSQL migration](#appendix-b--what-was-changed-during-the-postgresql-migration)
- [Appendix C · Optional — running the project locally someday](#appendix-c--optional--running-the-project-locally-someday)
- [Appendix D · What is inside the project zip](#appendix-d--what-is-inside-the-project-zip)

---

## Part 0 · How the pieces fit together

```
   Your team's browsers
          │
          ▼
┌──────────────────┐      SQL queries      ┌──────────────────┐
│  Vercel (app)    │ ────────────────────▶ │  Neon (database) │
│  Next.js + API   │ ◀──────────────────── │  PostgreSQL 17   │
└──────────────────┘      JSON results     └──────────────────┘
                                                     ▲
          ┌──────────────────┐                       │
          │ pgAdmin 4        │ ──── read-only ───────┘
          │ (optional, on    │      inspection
          │  your computer)  │
          └──────────────────┘
```

- **Vercel** runs the website itself (the pages you see and the API the pages talk to). It is free for this kind of project.
- **Neon** stores the data (users, test cases, bugs, reviews, activity logs). It is a real PostgreSQL server in the cloud with a generous free tier.
- **GitHub** stores your source code. Vercel watches the repository: every time you update the code, Vercel automatically redeploys the site.
- **pgAdmin 4** (optional) is a desktop tool that lets you look at the raw data tables — useful for learning and debugging.

**Total time: about 25–35 minutes.** Here is the plan:

| Step | What you do | Time |
|---|---|---|
| 1 | Create Neon account + database, copy 2 connection strings | ~5 min |
| 2 | Paste `database-setup.sql` into Neon's SQL Editor | ~2 min |
| 3 | Upload the project to GitHub | ~10 min |
| 4 | Import the repo into Vercel, add 3 environment variables, deploy | ~5 min |
| 5 | Open `your-link/api/seed` in the browser, log in, verify | ~3 min |

---

## Part 1 · Create the free database on Neon

### 1.1 Sign up

1. Open **https://neon.tech** in your browser.
2. Click **Sign Up** and choose **Continue with GitHub** (recommended) or email.
3. Answer the onboarding questions any way you like (they don't matter). On the plan screen choose the **Free** (Hobby) plan.

### 1.2 Create the project

1. Click **Create project** (or **New project**).
2. **Project name:** `tcms`
3. **PostgreSQL version:** leave the default (17 or higher is perfect).
4. **Cloud region:** pick the one closest to you or your team (e.g. `AWS Singapore`, `AWS Frankfurt`, `AWS US East`).
5. Click **Create project**.

After a few seconds Neon shows a **connection string** — a long text starting with `postgresql://`. This is the master key to your database. **Keep this page open** — you need it in a moment.

### 1.3 Understand the TWO connection strings

Neon gives every database **two** hostnames. This project uses both, and mixing them up is the #1 beginner mistake, so read this carefully:

| | **Pooled connection** | **Direct connection** |
|---|---|---|
| Hostname contains | `-pooler` | does **not** contain `-pooler` |
| Port | `6543` | `5432` |
| Used in this project as | `DATABASE_URL` | `DIRECT_URL` |
| Why | Handles many short-lived connections — ideal for serverless apps on Vercel | Needed by tools that manage the schema (and by pgAdmin) |

### 1.4 Copy both strings

1. In the Neon console, click **Connect** (top of the Dashboard) or **Dashboard → Connection Details**.
2. Find the toggle/checkbox labeled **Pooled connection** (sometimes shown as "Connection pooling").
   - With the toggle **ON**, you see the **pooled** string (has `-pooler` and port `6543`) → this is your future `DATABASE_URL`.
   - With the toggle **OFF**, you see the **direct** string (no `-pooler`, port `5432`) → this is your future `DIRECT_URL`.
3. Copy **both** strings into a text file. They look like:

```
postgresql://neondb_owner:AbCd1234@ep-cool-name-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
postgresql://neondb_owner:AbCd1234@ep-cool-name-a1b2c3d4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

> ⚠️ **Security:** these strings contain your database password. Don't post them in chats or screenshots. If you ever leak one, reset it: Neon console → **Dashboard → Reset password**.

> 💡 Keep `?sslmode=require` at the end of both strings — it encrypts the connection. Neon always includes it; don't delete it.

**✅ Checkpoint:** you have two strings saved — one with `-pooler`, one without.

---

## Part 2 · Create the tables (paste one file — 2 minutes)

Your empty Neon database has no tables yet. Normally you would run a command on your computer to create them — but the project zip includes a ready-made SQL file, so you can do it entirely in the browser.

### 2.1 Open the SQL file

1. Unzip `tcms-postgresql.zip` on your computer.
2. Open the folder, go into `prisma/` and find **`database-setup.sql`**.
3. Open it with any text editor (Notepad on Windows, TextEdit on Mac).
4. Select all (**Ctrl+A** / **Cmd+A**) and copy (**Ctrl+C** / **Cmd+C**).

### 2.2 Run it in Neon

1. Go to **https://console.neon.tech** and open your `tcms` project.
2. Click **SQL Editor** in the left sidebar.
3. Click into the editor, paste the file (**Ctrl+V** / **Cmd+V**) and press **Run**.
4. You should see **"Success"** (or "The query returned no results" — that is fine too).

### 2.3 Verify

In the left sidebar click **Tables** (or **Dashboard → Tables**). You should now see **14 tables**:

`ActivityLog, Bug, BugTestCaseLink, Module, ModulePermission, ModuleReviewRequest, RefreshToken, ReviewEvent, ReviewRequest, TaskReport, TestCase, TestCaseHistory, User, Notification`

> 💡 The file creates **structure only** — no data. The demo data (4 users, sample test cases, bugs) is added in Part 5 with one click. You can also re-run `database-setup.sql` later without breaking anything: running it twice simply reports that the tables already exist.

**✅ Checkpoint:** 14 tables visible in Neon.

---
## Part 3 · Put the code on GitHub

Vercel deploys from a Git repository, so the code needs to live on GitHub first. Pick **one** of the two options below:

- **Option A — upload in the browser.** Nothing to install. Good for you if you don't want any tools on your computer.
- **Option B — install Git once.** Four commands in a terminal. More reliable if you plan to update the project often (Appendix C and general development).

### Option A · Upload through the browser (no installs)

The project contains ~120 files. GitHub allows dragging **up to 100 files per upload**, so you will do it in **two drags**.

**Step 1 — Create the repository**

1. Go to **https://github.com/new** (log in if asked).
2. **Repository name:** `tcms`
3. Choose **Private** (recommended) or Public — Vercel works with both.
4. Do **NOT** tick "Add a README file" — the project already includes its own `README.md`.
5. Click **Create repository**.

**Step 2 — Upload the files**

1. On the new empty repo page, click the link **"uploading an existing file"**.
2. Open the unzipped project folder **on your computer** so you can see its contents.
3. **First drag:** select the four folders `src`, `prisma`, `public`, `mini-services` and drag them onto the GitHub upload area. Wait until the file list shows them uploaded (they appear with their folder names — GitHub preserves the folder structure automatically).
4. **Second drag:** select **all the remaining loose files** in the folder root (everything that is not a folder: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `components.json`, `.gitignore`, `.env.example`, `README.md`, `DEPLOYMENT-GUIDE.md`, `CODE-QUALITY-ROADMAP.md`) and drag them the same way. Hidden files like `.gitignore` may not be selectable depending on your OS — see the tip below.
5. **Commit message:** type `Initial import`, then click **Commit changes**.

> 💡 **Dragging hidden files (`.gitignore`, `.env.example`):** in the file explorer, use "select all" (**Ctrl+A** / **Cmd+A**) in the folder before dragging — that includes hidden files. If `.gitignore` still didn't make it, create it later in GitHub: **Add file → Create new file**, name it `.gitignore`, copy its content from the zip. It matters: it prevents committing secret files later.

**Step 3 — Verify**

Back on the repo home page you should see the folders `src`, `prisma`, `public`, `mini-services` and the loose files. Click into `src/app/api` — you should see the API folders. If anything is missing, drag it in the same way (GitHub merges into existing folders).

> ⚠️ **Do not** create a `.env` file in the repository and never paste your database password into GitHub. The configuration happens in Part 4 through Vercel's environment variables.

### Option B · Install Git once and push (recommended for frequent updates)

1. Install Git: **https://git-scm.com/downloads** → choose your OS → install with all default options.
2. Open a terminal:
   - **Windows:** press Start, type `PowerShell`, open it.
   - **macOS:** open **Terminal** from Applications.
3. `cd` into the unzipped project folder. On Windows the easiest way: open the folder in Explorer, click the address bar, type `powershell` and press Enter. Then run:

```bash
git init
git add .
git commit -m "Initial import"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/tcms.git
git push -u origin main
```

(Replace `YOUR-USERNAME` with your GitHub username. You can copy the exact URL from the "Quick setup" section of your new empty repo page.)

> 💡 On your first push a GitHub login window appears — choose **"Sign in with your browser"** and authorize. You never need to type a password.

**✅ Checkpoint:** your repository at `https://github.com/YOUR-USERNAME/tcms` shows the project files.

---

## Part 4 · Deploy to Vercel

### 4.1 Import the repository

1. Go to **https://vercel.com** and click **Sign Up → Continue with GitHub** (use the same GitHub account that holds the repo). Authorize Vercel when asked.
2. After landing on the dashboard click **Add New → Project**.
3. Find `tcms` in the repository list and click **Import**.
   (If it's not listed, click **Adjust GitHub App Permissions** and grant Vercel access to the repo.)

### 4.2 Configure the project

Vercel auto-detects everything:

| Setting | Value | Action |
|---|---|---|
| Framework Preset | Next.js | leave as detected |
| Build Command | `next build` | leave default |
| Install Command | `npm install` | leave default |

**Now the important part — Environment Variables.** Before clicking Deploy, open the **Environment Variables** section and add these **three** rows exactly (get the values from Part 1.4):

| Name | Value | Where the value comes from |
|---|---|---|
| `DATABASE_URL` | `postgresql://...@ep-xxx-**-pooler**...neon.tech/neondb?sslmode=require` | the **pooled** string (has `-pooler`, port 6543) |
| `DIRECT_URL` | `postgresql://...@ep-xxx...neon.tech/neondb?sslmode=require` | the **direct** string (no `-pooler`, port 5432) |
| `JWT_SECRET` | a long random string, e.g. `16f616964e8681983f19de30eab2c93b24a2a3afc0df9c2b` | see below |

**About `JWT_SECRET`** — it signs login tokens; any long random text works:

- **Easiest:** copy the sample string above.
- **Better — make your own in the browser:** press **F12** anywhere on a webpage, open the **Console** tab, paste this and press Enter:

```js
[...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("")
```

Copy the output and use it as the value.

> ⚠️ Names must match **exactly** (uppercase with underscores). A typo here is the most common cause of a broken deployment. Double-check `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`.

### 4.3 Deploy

1. Click **Deploy**.
2. Wait 2–4 minutes. Vercel installs the dependencies, generates the Prisma client and builds the app. You'll see the build log scrolling — that's normal.
3. When you see the 🎉 **"Congratulations"** screen, click **Continue to Dashboard**.

### 4.4 Your project link

At the top of the project dashboard you'll see the live URL, something like:

```
https://tcms-xxxxx.vercel.app
```

**This is the link of your project.** Open it in a browser — anywhere in the world. You can share it with your team, put it on your CV, or attach a custom domain later (Part 7.1). Click **Copy** next to the URL in the Vercel dashboard to grab it.

> 💡 Every future change you push to GitHub is deployed automatically — no manual steps (see Part 7.2).

**✅ Checkpoint:** the deployment shows "Ready" and the URL opens a login page (the page itself works even before the next step).

---

## Part 5 · Activate your app and log in

The database tables exist (Part 2) but are still empty. One browser click fills them with the demo data:

### 5.1 Seed the database from the browser

1. Open your app: `https://tcms-xxxxx.vercel.app` — you should see the TCMS login page with the demo account hints.
2. In a **new tab**, open: `https://tcms-xxxxx.vercel.app/api/seed` (your link + `/api/seed`).
3. You should see JSON like:

```json
{"seeded":true,"users":["admin@tcms.com","teamlead@tcms.com","qa1@tcms.com","qa2@tcms.com"],"modules":9,"testCases":5,"bugs":3,"taskReports":2}
```

> 💡 This endpoint is **idempotent and safe**: if the database already has users it does nothing (`{"seeded":false,...}`). Refreshing the page or clicking it a hundred times cannot duplicate or corrupt data.

### 5.2 Log in

Back on the login page, sign in with the admin account:

| Email | Password | Role |
|---|---|---|
| `admin@tcms.com` | `Admin@123` | admin — full access |
| `teamlead@tcms.com` | `Lead@123` | team lead |
| `qa1@tcms.com` | `QA@12345` | QA engineer |
| `qa2@tcms.com` | `QA@12345` | QA engineer |

### 5.3 Post-deployment checklist

Log in as `admin@tcms.com` and click through this list — everything should work:

- ✅ **Dashboard** shows statistics (5 test cases, 3 bugs) and a chart.
- ✅ **Test Cases** lists 5 sample cases with colored tag chips.
- ✅ Open any test case — the **steps table** renders from the database (JSONB).
- ✅ **Reviews**, **Bugs**, **Task Reports** pages all show sample data.
- ✅ **Activity Log** shows the seed events.
- ✅ Log out, log back in as `teamlead@tcms.com` — the UI reflects the smaller permission set.

### 5.4 Make it yours (recommended)

The demo accounts are documented publicly, so for any serious use:

1. Log in as `admin@tcms.com` → open **Settings / Users**.
2. Change the admin password, or register your own account (the login page has a registration option — the first registered user becomes admin if the DB was empty, otherwise they join with the QA role) and demote/delete the demo users.
3. The `/api/seed` endpoint is now permanently harmless — with users in the database it does nothing.

**✅ Checkpoint:** you are logged in at your own `*.vercel.app` link and the checklist above passes. **Your project is live.** 🎉

---
## Part 6 · Optional — browse the database with pgAdmin 4

The app is already running, but it's worth seeing the raw data at least once — it makes the whole system much less mysterious.

### 6.1 Install pgAdmin 4

1. Download from **https://www.pgadmin.org/download/pgadmin-4-windows/** (or the macOS/Linux page) and install with default options. First launch asks you to set a **master password** — this only protects pgAdmin itself, pick anything you like.

### 6.2 Register the Neon server

1. In pgAdmin's left panel: **Servers → right-click → Register → Server...**
2. **General tab:** Name = `TCMS-Neon` (anything you like).
3. **Connection tab** — this maps directly onto your **direct** connection string (the one **without** `-pooler`, port 5432):

   | pgAdmin field | What to enter | Example |
   |---|---|---|
   | Host name/address | the part between `@` and `/` of the DIRECT string | `ep-cool-name-a1b2c3d4.ap-southeast-1.aws.neon.tech` |
   | Port | `5432` | |
   | Maintenance database | the part after the last `/` | `neondb` |
   | Username | the part between `://` and `:` | `neondb_owner` |
   | Password | the part between `:` and `@` | (your Neon password) |
   | Save password | ✅ tick | |

4. **SSL tab** (critical!): change **SSL mode** from `disable` to **`Require`**.
   > ⚠️ Forgetting `SSL mode = Require` is the single most common pgAdmin + Neon error ("connection refused" / SSL errors). Neon does not allow unencrypted connections.
5. Click **Save**. After a few seconds `TCMS-Neon` appears under Servers.

### 6.3 Look at the data

Expand: **TCMS-Neon → Databases → neondb → Schemas → public → Tables** — you'll recognise the 14 tables. Right-click any table (try `User` or `TestCase`) → **View/Edit Data → All Rows**.

- The JSONB columns (`steps`, `tags`, `tasks`...) display as readable JSON — this is what the app parses into tables and chips.
- It's completely safe to browse; just avoid editing data by hand while learning (the app expects its validation rules).

> 💡 **No-install alternative:** Neon's **SQL Editor** (from Part 2) can run `SELECT * FROM "TestCase";` — table names are case-sensitive, so quote them exactly like that.

**✅ Checkpoint:** you can see rows in the `User` and `TestCase` tables.

---

## Part 7 · Daily use, limits and updates

### 7.1 Sharing your app

- The `https://tcms-xxxxx.vercel.app` link works for anyone, anywhere, on any device. Teammates register via the login page (or you create users in Settings).
- **Custom domain** (optional): Vercel → your project → **Settings → Domains** → add e.g. `tcms.yourdomain.com` and follow the DNS instructions. Free SSL included.

### 7.2 Updating the app

Your deployment is wired to GitHub:

- **Changed a file?** Edit it on github.com (pencil icon on any file) or push with Git — Vercel detects the push and **redeploys automatically** (watch the progress in the Vercel dashboard).
- **Changed environment variables?** Vercel → Settings → Environment Variables → edit → then **Deployments → ⋯ → Redeploy** on the latest deployment. (A redeploy is required for var changes to take effect.)

### 7.3 Free tier limits — what to expect

| | Free tier | Practical meaning for this project |
|---|---|---|
| **Neon storage** | 0.5 GB | Thousands of test cases — you won't hit it soon. |
| **Neon cold starts** | sleeps after ~5 min idle | The **first** page load after a break may take 3–8 seconds while the database wakes up. After that it's fast. This is normal, not a bug. |
| **Vercel Hobby** | 100 GB bandwidth/month | Far more than a team tool needs. Non-commercial use. |
| **Vercel function duration** | 10 s per request (Hobby) | Plenty for this app; heavy reports should be paginated (they already are). |

### 7.4 Real-time updates note

The project includes a small WebSocket service (`mini-services/`) that pushes live updates between users. Vercel's serverless platform doesn't host persistent WebSocket servers, so on Vercel this degrades gracefully: **changes made by one user appear to teammates after a page refresh** instead of instantly. Everything else — reviews, notifications bell, activity log — works fully. If you ever want true real-time, deploy `mini-services/` to Railway or Render (it has zero database dependencies) — but that is entirely optional.

### 7.5 Backups

- Neon free tier keeps **point-in-time recovery** for 6 hours on the free plan; you can also create a **branch** (an instant copy) of your database anytime: Neon console → **Branches → Create branch**.
- Full export anytime from pgAdmin: right-click database → **Backup…** (or run `pg_dump`).

---

## Part 8 · Troubleshooting FAQ

**Q1. Vercel build fails with `prisma: command not found` or "Generate client" errors.**
The project's `package.json` already includes `"postinstall": "prisma generate"`. If you removed or renamed it, restore it. Also confirm `package-lock.json` was uploaded — Vercel uses it for reproducible installs.

**Q2. The site loads, but login or any page shows `Internal server error` / 500.**
Almost always one of the three environment variables is missing, misspelled, or empty. Vercel → Settings → Environment Variables: verify `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` exist for the *Production* environment, fix, then **Deployments → Redeploy**.

**Q3. Error contains `P1001 can't reach database` or `Error querying the database`.**
The connection string is wrong. Check: (1) host spelled exactly as Neon shows it, (2) password pasted completely (no spaces/newlines), (3) `?sslmode=require` still at the end, (4) the Neon project isn't deleted/suspended. Also remember the cold-start: if the database slept, the first request can take a few seconds — retry once.

**Q4. Opening `/api/seed` returns `{"seeded":false,"message":"Database already has users..."}`.**
Good news — it's already seeded (or you seeded earlier). This is the normal no-op response, not an error.

**Q5. Login rejects `admin@tcms.com`.**
The seed step (5.1) wasn't done on *this* database — open `https://your-link.vercel.app/api/seed` first. Also check you're on your own domain (not the Vercel project of someone else's example) and the email is all lowercase.

**Q6. pgAdmin fails to connect ("connection refused", timeout, SSL error).**
Two classic causes: (1) **SSL mode not set to Require** — fix in the server's SSL tab; (2) you used the **`-pooler`** hostname — pgAdmin needs the **direct** (non-pooler) host and port `5432`.

**Q7. I want to wipe the demo data and start clean.**
In Neon SQL Editor run:

```sql
TRUNCATE "ActivityLog", "Notification", "ReviewEvent", "ReviewRequest", "ModuleReviewRequest",
         "BugTestCaseLink", "Bug", "TestCaseHistory", "TestCase", "TaskReport",
         "ModulePermission", "RefreshToken", "Module", "User" CASCADE;
```

Then open `/api/seed` once to re-seed fresh demo data (or don't — and register your own account, which becomes admin on an empty database).

**Q8. I edited files on my computer — does Vercel see them?**
No. Vercel deploys what is on **GitHub**. Either edit directly on github.com, or push from your computer with Git (Option B in Part 3).

**Q9. Deploy succeeded, but I changed an environment variable and nothing changed.**
Variable changes apply only to **new** deployments: after saving, go to **Deployments → ⋯ → Redeploy**.

**Q10. The first request after idle feels very slow.**
Neon free tier sleeps the database after ~5 minutes of inactivity. The first connection wakes it (3–8 s); everything afterwards is fast again. Nothing to fix.

---

## Appendix A · Connection string cheat sheet

You collected two strings in Part 1. Here is where each one goes — and nowhere else:

| Consumer | Use this string | Field name there | Host contains | Port |
|---|---|---|---|---|
| **Vercel** env var | **Pooled** | `DATABASE_URL` | `-pooler` | 6543 |
| **Vercel** env var | **Direct** | `DIRECT_URL` | no `-pooler` | 5432 |
| **pgAdmin 4** | **Direct** | Connection tab fields | no `-pooler` | 5432 |
| **Neon SQL Editor** | (none — runs inside Neon) | — | — | — |
| Local `.env` (Appendix C) | either (both vars same value) | `DATABASE_URL`, `DIRECT_URL` | — | — |

Memory rule: **the app takes the pooler, the tools take the direct one.**

## Appendix B · What was changed during the PostgreSQL migration

The original project ran on SQLite (a file database). It now runs on cloud PostgreSQL. Code you interact with is unchanged — the migration was surgical:

- `prisma/schema.prisma`: provider switched to `postgresql`; a `directUrl` added so schema tools use Neon's direct endpoint while the app uses the pooled one.
- **10 columns previously stored as JSON-text are now native `JSONB`** (`TestCase.steps/tags/attachments`, `TestCaseHistory.snapshot`, `ReviewEvent.flaggedFields`, `Bug.attachments`, `TaskReport.tasks`, `ActivityLog.beforeSnapshot/afterSnapshot/diff`). JSONB is indexed, queryable and faster; the app's JSON-parsing layer was made polymorphic so both formats read identically — **zero frontend changes were needed**.
- Verified before packaging: `next build` passes; a fresh database created **only** from `database-setup.sql` accepts the seed endpoint, login, and all 9 API routes returning correct JSONB data (steps arrays, tag chips, task lists round-trip perfectly).

## Appendix C · Optional — running the project locally someday

You don't need this to run the deployed app, but if you ever want to develop on your own machine:

1. Install **Node.js 20+** from https://nodejs.org (LTS version).
2. In the project folder, copy `.env.example` to a new file named `.env` and fill in your Neon strings for both `DATABASE_URL` and `DIRECT_URL` (same values as Vercel) plus any `JWT_SECRET`.
3. Run:

```bash
npm install        # installs dependencies (auto-generates the Prisma client)
npm run dev        # starts http://localhost:3000
```

4. Visiting `http://localhost:3000/api/seed` seeds your Neon database — since it's the same database production uses, prefer creating a separate Neon **branch** for experiments.

## Appendix D · What is inside the project zip

| Item | What it is |
|---|---|
| `src/` | The whole application: pages, components and the API routes (`src/app/api/...`) |
| `prisma/schema.prisma` | Database schema definition (14 tables) |
| `prisma/database-setup.sql` | ⭐ Ready-made SQL that creates all tables — used in Part 2 |
| `mini-services/` | Optional WebSocket service (see Part 7.4) |
| `public/` | Static assets (logo, robots.txt) |
| `package.json` / `package-lock.json` | Dependencies; the lockfile makes Vercel installs reproducible |
| `next.config.ts`, `tailwind.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`, `components.json` | Build & UI configuration — leave as is |
| `.env.example` | Template showing which environment variables exist (never contains real secrets) |
| `.gitignore` | Keeps secrets and build output out of Git |
| `README.md` | Short project overview |
| `DEPLOYMENT-GUIDE.md` | This guide |
| `CODE-QUALITY-ROADMAP.md` | Engineering notes from development (optional reading) |



---

## Appendix E · Alternative database providers — no 5-minute sleeps

Neon's free tier puts the database to sleep after ~5 minutes of inactivity, so the
first page load after a break takes 3–8 seconds. If that bothers you, two free
alternatives exist — and **your project already ships with the tooling for them**:
a keep-alive endpoint (`/api/keep-alive`) plus a scheduled daily ping (`vercel.json`).

### E.1 Option 1 (recommended) — Supabase + automatic daily keep-alive

Supabase (https://supabase.com) is another free PostgreSQL host. Its free tier pauses
a project only after **7 days of complete inactivity** — and the app you deployed
prevents that automatically:

- `vercel.json` schedules a **Vercel Cron** job (the free Hobby plan allows one run
  per day — exactly enough here)
- The cron calls `/api/keep-alive` once a day, which runs one trivial query
  (`SELECT 1`)
- To Supabase that counts as activity, so the 7-day pause **never triggers**

**Steps:**

1. Go to https://supabase.com → **Continue with GitHub** → **New project**: name
   `tcms`, pick a region near you → **Create new project**. Supabase shows a
   generated **database password** — copy it and save it in a text file (you cannot
   view it again later; you can only reset it).
2. Wait ~2 minutes for provisioning, then click **Connect** (top bar of the project
   dashboard). Supabase shows several connection strings.
3. In Vercel → your project → **Settings → Environment Variables**, set:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the **Transaction pooler** string (port `6543`) with `?pgbouncer=true&connection_limit=1` appended at the end |
   | `DIRECT_URL` | the **Session pooler** string (port `5432` on the `...pooler.supabase.com` host) |
   | `JWT_SECRET` | unchanged — keep your existing value |

   Replace the `[YOUR-PASSWORD]` placeholder in both strings with the password from
   step 1.

   > Why the pooler strings? Supabase's direct hostname (`db.xxx.supabase.co`) only
   > resolves over IPv6, which some networks and serverless platforms cannot reach.
   > The `pooler.supabase.com` hostnames work everywhere. `pgbouncer=true` is
   > required by Prisma on the transaction pooler (Supabase documents this).
4. Create the tables: Supabase dashboard → **SQL Editor** (left sidebar) → copy the
   full contents of `prisma/database-setup.sql` → paste → **Run**. You get the same
   14 tables as on Neon.
5. **Redeploy** your Vercel project (Deployments → ⋯ → Redeploy) so the new env
   vars take effect. Then open `https://your-link.vercel.app/api/seed` and log in
   as before.
6. Verify the keep-alive: open `https://your-link.vercel.app/api/keep-alive` once —
   it should answer `{"ok":true,...}`. From now on, Vercel pings it **daily
   automatically** (see the **Cron Jobs** tab of your Vercel project).

> 💡 Switching from Neon to Supabase starts with an empty database — run the seed
> endpoint once and you're back to the demo data. Copying existing data over is a
> manual export/import job (pgAdmin backup/restore works).

### E.2 Option 2 — Aiven: a free database that NEVER sleeps (no cron needed)

Aiven (https://aiven.io) offers a free PostgreSQL that is **always on** — no
sleeping at all, no credit card, no expiry. Trade-offs: about 1 GB storage (plenty
for TCMS) and a console aimed more at ops people than app developers.

1. https://aiven.io → sign up (no card needed) → **Create service → PostgreSQL** →
   pick the **Free plan** and a region → wait ~5 minutes for it to boot.
2. Open the service → **Connection information** → copy the **Service URI**
   (looks like `postgres://avnadmin:...@pg-xxx.aivencloud.com:12345/defaultdb?sslmode=require`).
3. In Vercel, set **both** `DATABASE_URL` **and** `DIRECT_URL` to that same URI
   (Aiven has no pooled/direct distinction — one string for everything, which makes
   setup simpler). Keep `JWT_SECRET` unchanged → **Redeploy**.
4. Create the tables once with **pgAdmin 4** (connect exactly as in Part 6, using
   the host/port/user/password/database from Aiven's Connection information page,
   SSL mode **Require**): open the **Query Tool** on your database, paste
   `prisma/database-setup.sql`, execute. Then open `/api/seed`, log in, done.

### E.3 Comparison

| | Neon free | Supabase free | Aiven free |
|---|---|---|---|
| Sleeps? | Yes — after ~5 min idle (3–8 s wake-up) | Only after 7 idle days — **prevented by the built-in daily keep-alive** | **Never** |
| Setup effort | Medium (2 connection strings) | Medium (pooler strings + params) | Low (single URI for both vars) |
| SQL editor in dashboard | Yes | Yes (easiest table setup) | No — use pgAdmin once |
| Storage | 0.5 GB | 0.5 GB | ~1 GB |
| Credit card | No | No | No |

> 💡 The keep-alive files (`vercel.json` + `/api/keep-alive`) ship with the project
> and are harmless with **every** provider — with Neon they simply do nothing
> special, with Supabase they prevent pauses forever.

---

## Part 9 · Backup, restore & rollback runbook (pre-launch requirement)

### 9.1 What to back up, how often

| Asset | Method | Frequency |
|---|---|---|
| Database (the only stateful part) | `node scripts/backup-db.mjs` → `backups/tcms-backup-<timestamp>.json.gz` | **Daily** + immediately before any deploy |
| Code + build | git repository (tag each release, e.g. `git tag v1.0.0`) | Every release |
| Environment variables | recorded in your deployment platform + one off-line copy | On change |

For Neon/Vercel deployments, also enable Neon's built-in point-in-time restore in
the Neon console — it complements (not replaces) the logical backup below.

### 9.2 Backup — 1 command

```bash
export DATABASE_URL="postgresql://…"        # the same URL the app uses
node scripts/backup-db.mjs                  # writes backups/tcms-backup-<ts>.json.gz
```

It dumps **all 15 tables** (FK-safe order, JSON rows, gzipped, ~0.5 MB for a seeded
DB) and prints per-table row counts. Copy the file off the machine (S3 / GitHub
release asset / your laptop) — a backup that lives only on the server is not a backup.

### 9.3 Restore — drill before you need it (already verified)

```bash
export DATABASE_URL="postgresql://…"
node scripts/restore-db.mjs --file backups/tcms-backup-<ts>.json.gz --database tcms_drill
```

The restore script re-applies `prisma/database-setup.sql` (schema) into the target
database, re-inserts every table, and **verifies row counts against the backup**.
The drill pattern above restores into a THROWAWAY database (`tcms_drill`) — verify
the output ends with `RESTORE VERIFIED`, then drop it:

```sql
DROP DATABASE tcms_drill;
```

For a REAL disaster recovery, run the same command with `--database tcms` after
stopping the app. This exact drill was executed during the pre-launch audit and
passed (`RESTORE VERIFIED: all 15 tables match the backup row counts.`).

### 9.4 Rollback plan

| Failure kind | Rollback |
|---|---|
| Bad deploy (app broken after release) | `git checkout <previous tag> && npm install && npm run build` and redeploy / restart. No data steps involved — schema unchanged. |
| Bad migration (schema changed wrongly) | Restore the pre-deploy backup (9.3) into the production database, then deploy the previous code tag. |
| Data corruption / accidental mass delete | Restore the most recent backup into a scratch DB (`tcms_drill`), extract the good rows, merge back — or restore wholesale if the damage is widespread. |
| Server lost entirely | New machine: `npm install` → `node scripts/restore-db.mjs --file <latest backup> --database tcms` → set env vars → `npm run build && npm start`. |

**Rule of thumb:** deploy = backup first (`scripts/backup-db.mjs`), then release.
A deploy without a fresh backup is the one thing this runbook cannot save you from.

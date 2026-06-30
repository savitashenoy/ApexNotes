# Notes — Vercel Deployment

A Flask + SQLAlchemy notes app (Apple Notes–style) with email/password auth,
folders, pinning, drag-and-drop reordering, sticky-notes view, and CSV export
— packaged to deploy on **Vercel** as a Python serverless function.

## What changed for Vercel

- The Flask app now lives at **`api/index.py`** (Vercel's convention for a
  Python serverless function).
- The database is **PostgreSQL** instead of SQLite — Vercel's filesystem is
  read-only/ephemeral at runtime, so SQLite can't persist data between
  requests. Any Postgres provider works (Vercel Postgres, Neon, Supabase,
  Railway, etc.).
- `vercel.json` routes all non-static requests to the Python function and
  serves `/static/*` directly.
- `SECRET_KEY` and `DATABASE_URL` are read from environment variables instead
  of being hardcoded.

## Deploy steps

### 1. Push this folder to a GitHub repo
```bash
git init
git add .
git commit -m "Notes app — Vercel ready"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Create a Postgres database
Easiest option — inside the Vercel dashboard:
**Storage tab → Create Database → Postgres**. Vercel automatically sets the
`DATABASE_URL` environment variable for you when you connect it to the
project.

Alternatively use a free [Neon](https://neon.tech) or
[Supabase](https://supabase.com) Postgres instance and copy its connection
string manually into step 3.

### 3. Import the project into Vercel
- Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo.
- Vercel will detect `vercel.json` and the Python function automatically.
- Under **Settings → Environment Variables**, add:
  - `DATABASE_URL` — your Postgres connection string (skip if you connected
    Vercel Postgres in step 2, it's already set)
  - `SECRET_KEY` — any long random string, e.g. generate one with:
    ```bash
    python -c "import secrets; print(secrets.token_hex(32))"
    ```

### 4. Deploy
Click **Deploy**. Vercel installs `requirements.txt` and builds the
serverless function. First load will run `db.create_all()` automatically,
creating the `user`, `folder`, and `note` tables.

### 5. Open the app
Visit your `*.vercel.app` URL — you'll land on the login page. Sign up for
an account, and you're in.

## Local development

```bash
pip install -r requirements.txt
cp .env.example .env     # then edit DATABASE_URL / SECRET_KEY
python api/index.py
```
Without a `DATABASE_URL` set, the app falls back to a local SQLite file
(`notes.db`) for convenience — this only works locally, not on Vercel.

## Project structure

```
.
├── api/
│   └── index.py          # Flask app — Vercel serverless entry point
├── static/
│   ├── css/style.css
│   └── js/app.js
├── templates/
│   ├── login.html        # Sign in / sign up / change password
│   └── index.html        # Notes app shell
├── vercel.json            # Routing + build config
├── requirements.txt
├── .env.example
├── .gitignore
└── .vercelignore
```

## Features

- Email/password authentication (signup, login, logout, change password) with
  hashed passwords and per-user data isolation
- Folders: create, rename, delete, drag notes between them
- Notes: rich-text editor (Quill.js), pin, search, sort, soft-delete with a
  30-day "Recently Deleted" retention window
- Two views: classic list and a sticky-notes grid, both with drag-and-drop
  reordering and drag-to-folder
- CSV export of all notes in the current folder
- Open Sans throughout, collapsible side panels, adjustable font size/line
  spacing/editor width in Settings

## Notes on serverless behavior

- Each request may hit a different (cold or warm) serverless instance, so
  `pool_pre_ping=True` is set on the SQLAlchemy engine to transparently
  reconnect if a pooled connection has gone stale.
- Session cookies (via Flask-Login) are how login state persists across
  requests — make sure `SECRET_KEY` stays constant across deploys, or all
  users will be logged out whenever it changes.

## Troubleshooting

**"Internal Server Error" / `sqlite3.OperationalError: unable to open database file`**
This means `DATABASE_URL` is not set in your Vercel project. Vercel's
filesystem is read-only at runtime, so the app cannot fall back to SQLite the
way it does locally — it requires a real Postgres connection. Go to
**Project Settings → Environment Variables**, add `DATABASE_URL` (see step 2
above), and redeploy. With this fixed, a missing `DATABASE_URL` now fails
immediately with a clear error message at cold start instead of crashing on
every request.

**"Could not connect to the database" (503 response)**
The app started fine but couldn't reach Postgres on a specific request —
usually a typo'd connection string, an expired/rotated database password, or
the database being paused (common on free-tier Neon/Supabase after
inactivity). Double-check `DATABASE_URL` and that the database is awake.

**Random logouts — e.g. "I created a folder and got logged out"**
This means `SECRET_KEY` is not set in your Vercel environment variables.
Without it, the app falls back to generating a random key — and on Vercel,
every "cold start" can spin up a brand-new function instance with its *own*
random key. A session cookie signed by one instance won't verify on another,
so any action that happens to hit a fresh instance looks like an instant
logout. Fix: set a **fixed** `SECRET_KEY` value in
**Project Settings → Environment Variables** (generate one with
`python -c "import secrets; print(secrets.token_hex(32))"`), then redeploy.
With this fixed, a missing `SECRET_KEY` now fails immediately and clearly at
cold start instead of silently causing intermittent logouts.

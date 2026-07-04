# Notes — Vercel Deployment

A Flask + SQLAlchemy notes app (Apple Notes–style) with email/password auth,
folders, pinning, drag-and-drop reordering, sticky-notes view, CSV export,
and an admin panel — packaged to deploy on **Vercel** as a Python serverless
function.

---

## Features

### Core notes
- Rich-text editor (Quill.js) with Heading / Subheading / Body styles,
  bold, italic, underline, strikethrough, bullet/numbered/checklist lists,
  indent, alignment, blockquote, code block, text & highlight colour, links,
  inline images
- Separate title input that autosaves independently from the body
- Autosave with 1.5 s debounce; flushes on tab close
- Live word count and Saved / Editing… status in the taskbar
- Pin notes, soft-delete with 30-day "Recently Deleted" retention

### Full-text search with filters
- Live search bar filters notes by title and body text as you type
- **Filter chips** narrow results further: All · Pinned · Today · This Week
- Search highlights matched text in both list and sticky views
- Combine search with any filter chip for compound queries
  (e.g. "search for 'meeting' within Pinned notes")

### Tags / labels  *(roadmap)*
- Inline `#tag` syntax in note body is parsed and indexed
- Tag chip filters will appear in the filter row alongside date filters
- Clicking a tag anywhere navigates to all notes with that tag
- Tags are stored as a normalised join table for fast lookup

### Nested subfolders  *(roadmap)*
- Folders will support a `parent_id` foreign key (self-referential)
- The sidebar tree will render collapsible indent levels
- Moving a parent folder moves all children with it
- Breadcrumb trail shown above the note list header

### Favorites / bookmarks  *(roadmap)*
- A star icon on each note row and sticky card
- A "Favorites" smart folder sits below "All Notes" in the sidebar
- Favorites persist independently of pin — a note can be both

### Public share links  *(roadmap)*
- A "Share" button in the taskbar generates a signed UUID token
- `GET /share/<token>` renders a read-only view of the note (no login needed)
- Token expiry is configurable (24 h / 7 d / never)
- Revoke button deletes the token immediately

### Export as PDF  *(roadmap)*
- "Export PDF" option in the taskbar dropdown next to CSV
- Uses WeasyPrint (server-side) or the browser's `window.print()` API
- Preserves Instrument Serif headings and all rich-text formatting
- Exports single note or entire folder as a multi-page PDF

### Bulk CSV import / export
- **Export (live):** Export ▾ button in the taskbar downloads all notes in
  the current folder view as a UTF-8 BOM CSV (Excel-compatible).
  Columns: ID · Title · Folder · Pinned · Content (plain text) · Created · Updated
- **Bulk import** *(roadmap):* Upload a CSV with the same schema; the importer
  maps columns, creates missing folders automatically, and skips duplicates by
  title + created date.

---

## Admin panel — `/Admin`

Separate superuser session (independent of Flask-Login).

| Credential | Value |
|------------|-------|
| User ID    | `superuser` |
| Password   | `June021999` |

**Members tab**
- Create new users (username + password; enabled by default)
- Search users by username or email
- Edit username or reset password via modal
- Enable / disable toggle (disabled users get 403 on login)
- Delete user (removes all their notes and folders)
- Users created via sign-up show their full email in the Username column;
  admin-created users show their username
- Admin-created users log in with their **username** in the Email/Username
  field on the login page

---

## Deploy to Vercel

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "init"
git remote add origin <your-repo-url> && git push -u origin main
```

### 2. Create a Postgres database
**Vercel dashboard → Storage → Create Database → Postgres.**
Vercel injects `DATABASE_URL` automatically when you link it to the project.
Alternatively use [Neon](https://neon.tech) or [Supabase](https://supabase.com)
and paste the connection string manually.

### 3. Import into Vercel
- [vercel.com/new](https://vercel.com/new) → import the repo
- **Settings → Environment Variables:**
  - `DATABASE_URL` — Postgres connection string (auto-set if using Vercel Postgres)
  - `SECRET_KEY` — any long random string:
    `python -c "import secrets; print(secrets.token_hex(32))"`
- Click **Deploy**

### 4. Open
Visit your `*.vercel.app` URL → login page. Sign up, and you're in.
The first request auto-creates all database tables and runs any pending
column migrations.

---

## Local development
```bash
pip install -r requirements.txt
cp .env.example .env   # add DATABASE_URL / SECRET_KEY
python api/index.py    # runs on http://127.0.0.1:5000
```
Without `DATABASE_URL`, falls back to a local `notes.db` SQLite file.

---

## Project structure
```
.
├── api/
│   └── index.py          # Flask app — Vercel serverless entry point
├── static/
│   ├── css/style.css     # Warm cream & forest green theme
│   └── js/app.js         # Vanilla JS front-end
├── templates/
│   ├── login.html        # Sign in / sign up / change password
│   ├── index.html        # Notes app shell
│   └── admin.html        # Admin panel
├── vercel.json
├── requirements.txt
├── .env.example
├── .gitignore
└── .vercelignore
```

---

## Troubleshooting

**`column user.username does not exist`**
Your database predates the `username` / `is_enabled` columns. The app runs
`ALTER TABLE` migrations automatically on first request after redeploy —
just deploy the latest code and the schema updates itself.

**`{"error":"Database connection failed."}`**
`DATABASE_URL` is set but the connection is failing. Check:
- The URL starts with `postgresql://` (not `postgres://` — the app fixes this
  automatically, but double-check)
- The database is not paused (free-tier Neon/Supabase sleep after inactivity)
- Rotate the database password and update the env var if needed

**Random logouts (e.g. after creating a folder)**
`SECRET_KEY` is not set as a fixed env var. Each serverless cold start
generates a new random key, invalidating other instances' cookies.
Set a stable `SECRET_KEY` in Vercel → Project Settings → Environment
Variables, then redeploy.

**Admin-created users can't log in**
Type the **username** (not the synthetic `@admin.local` email) in the
Email or Username field on the login page.

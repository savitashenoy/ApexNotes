"""
Apple Notes — Vercel serverless entry point.
Uses PostgreSQL via DATABASE_URL environment variable.
Set DATABASE_URL and SECRET_KEY in Vercel project settings.
"""
import csv
import html
import io
import os
import re
import secrets
import string
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import (Flask, Response, jsonify, redirect, render_template,
                   request, session, url_for)
from flask_login import (LoginManager, UserMixin, current_user, login_required,
                         login_user, logout_user)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

ROOT         = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(ROOT, "templates")
STATIC_DIR   = os.path.join(ROOT, "static")
TRASH_RETENTION_DAYS = 30
ADMIN_UID      = "superuser"
ADMIN_PASSWORD = "June021999"

def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)

# ── App & DB config ────────────────────────────────────────────────────────
app = Flask(__name__, template_folder=TEMPLATE_DIR,
            static_folder=STATIC_DIR, static_url_path="/static")

_db_url = os.environ.get("DATABASE_URL", "")
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

_on_vercel = bool(os.environ.get("VERCEL"))

if not _db_url:
    if _on_vercel:
        raise RuntimeError("DATABASE_URL is not set. Add it in Vercel Project Settings → Environment Variables.")
    _db_url = "sqlite:///" + os.path.join(ROOT, "notes.db")

_is_postgres = "postgresql" in _db_url

if _is_postgres:
    from sqlalchemy.pool import NullPool
    _engine_opts = {
        "poolclass": NullPool,
        "pool_pre_ping": False,
        "connect_args": {} if "sslmode" in _db_url else {"sslmode": "require"},
    }
else:
    _engine_opts = {}

app.config["SQLALCHEMY_DATABASE_URI"]        = _db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"]      = _engine_opts

_secret_key = os.environ.get("SECRET_KEY")
if not _secret_key:
    if _on_vercel:
        raise RuntimeError("SECRET_KEY is not set. Add it in Vercel Project Settings → Environment Variables.")
    _secret_key = secrets.token_hex(32)

app.config["SECRET_KEY"]              = _secret_key
app.config["SESSION_COOKIE_SECURE"]   = _on_vercel
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["REMEMBER_COOKIE_SECURE"]  = _on_vercel
app.config["REMEMBER_COOKIE_HTTPONLY"]= True
app.config["REMEMBER_COOKIE_SAMESITE"]= "Lax"

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view    = "login_page"
login_manager.login_message = ""

# ── Association table: note ↔ tag ──────────────────────────────────────────
note_tags = db.Table(
    "note_tags",
    db.Column("note_id", db.Integer, db.ForeignKey("note.id"), primary_key=True),
    db.Column("tag_id",  db.Integer, db.ForeignKey("tag.id"),  primary_key=True),
)

# ── Models ─────────────────────────────────────────────────────────────────
class User(UserMixin, db.Model):
    __tablename__ = "user"
    id            = db.Column(db.Integer, primary_key=True)
    email         = db.Column(db.String(254), unique=True, nullable=False)
    username      = db.Column(db.String(80),  unique=True, nullable=True)
    password_hash = db.Column(db.String(256), nullable=False)
    is_enabled    = db.Column(db.Boolean, default=True,  nullable=False)
    created_at    = db.Column(db.DateTime, default=utcnow)

    def set_password(self, p):   self.password_hash = generate_password_hash(p)
    def check_password(self, p): return check_password_hash(self.password_hash, p)

    def to_dict(self):
        return {"id": self.id, "email": self.email, "username": self.username}

    def to_admin_dict(self):
        is_admin_created = self.email.endswith("@admin.local")
        display = self.username if is_admin_created else self.email
        return {"id": self.id, "username": display, "email": self.email,
                "is_enabled": self.is_enabled,
                "created_at": self.created_at.strftime("%Y-%m-%d")}


@login_manager.user_loader
def load_user(uid): return db.session.get(User, int(uid))


class Tag(db.Model):
    __tablename__ = "tag"
    id      = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    name    = db.Column(db.String(60), nullable=False)
    color   = db.Column(db.String(7),  default="#5a7c50")   # hex
    __table_args__ = (db.UniqueConstraint("user_id", "name", name="uq_user_tag"),)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "color": self.color}


class Folder(db.Model):
    __tablename__ = "folder"
    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    parent_id  = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    name       = db.Column(db.String(120), nullable=False)
    is_default = db.Column(db.Boolean, default=False, nullable=False)
    sort_order = db.Column(db.Integer, default=0, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    children = db.relationship("Folder", backref=db.backref("parent", remote_side="Folder.id"),
                                lazy=True, foreign_keys="Folder.parent_id")
    notes    = db.relationship("Note", backref="folder", lazy=True, foreign_keys="Note.folder_id")

    def to_dict(self, depth=0):
        count = Note.query.filter_by(folder_id=self.id, is_deleted=False).count()
        return {"id": self.id, "name": self.name, "is_default": self.is_default,
                "parent_id": self.parent_id, "sort_order": self.sort_order,
                "note_count": count, "depth": depth}


class Note(db.Model):
    __tablename__ = "note"
    id          = db.Column(db.Integer, primary_key=True)
    user_id     = db.Column(db.Integer, db.ForeignKey("user.id"),    nullable=False)
    folder_id   = db.Column(db.Integer, db.ForeignKey("folder.id"),  nullable=False)
    title       = db.Column(db.String(255), default="New Note")
    content     = db.Column(db.Text, default="")
    plain_text  = db.Column(db.Text, default="")
    snippet     = db.Column(db.Text, default="")
    pinned      = db.Column(db.Boolean, default=False, nullable=False)
    is_favorite = db.Column(db.Boolean, default=False, nullable=False)
    is_deleted  = db.Column(db.Boolean, default=False, nullable=False)
    sort_order  = db.Column(db.Integer, default=0, nullable=False)
    share_token = db.Column(db.String(40), unique=True, nullable=True)
    share_expires = db.Column(db.DateTime, nullable=True)
    created_at  = db.Column(db.DateTime, default=utcnow)
    updated_at  = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)
    deleted_at  = db.Column(db.DateTime, nullable=True)
    tags        = db.relationship("Tag", secondary=note_tags, lazy=True)

    def to_dict(self, full=False):
        # Load tags via raw SQL — never trust the ORM lazy cache for note_tags
        # as it can bleed across notes sharing the same session/identity map.
        try:
            rows = db.session.execute(
                db.text("""
                    SELECT t.id, t.name, t.color
                    FROM tag t
                    JOIN note_tags nt ON nt.tag_id = t.id
                    WHERE nt.note_id = :nid
                    ORDER BY t.name
                """),
                {"nid": self.id}
            ).fetchall()
            tags_list = [{"id": r[0], "name": r[1], "color": r[2]} for r in rows]
        except Exception:
            tags_list = []

        d = {
            "id":          self.id,
            "folder_id":   self.folder_id,
            "title":       self.title or "New Note",
            "snippet":     self.snippet or "",
            "plain_text":  self.plain_text or "",
            "pinned":      self.pinned,
            "is_favorite": self.is_favorite,
            "is_deleted":  self.is_deleted,
            "sort_order":  self.sort_order,
            "share_token": self.share_token,
            "tags":        tags_list,
            "created_at":  self.created_at.isoformat() + "Z",
            "updated_at":  self.updated_at.isoformat() + "Z",
        }
        if self.deleted_at:
            d["deleted_at"] = self.deleted_at.isoformat() + "Z"
        if full:
            d["content"] = self.content or ""
        return d

# ── DB migrations ──────────────────────────────────────────────────────────
_db_initialised = False

def ensure_db():
    global _db_initialised
    if _db_initialised:
        return
    db.create_all()
    migrations = [
        ('ALTER TABLE "user" ADD COLUMN username VARCHAR(80)',),
        ('ALTER TABLE "user" ADD COLUMN is_enabled BOOLEAN NOT NULL DEFAULT TRUE',),
        ('ALTER TABLE note ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',),
        ("ALTER TABLE note ADD COLUMN plain_text TEXT DEFAULT ''",),
        ('ALTER TABLE note ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE',),
        ('ALTER TABLE note ADD COLUMN share_token VARCHAR(40)',),
        ('ALTER TABLE note ADD COLUMN share_expires TIMESTAMP',),
        ('ALTER TABLE folder ADD COLUMN parent_id INTEGER REFERENCES folder(id)',),
        ('ALTER TABLE folder ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',),
        # tag and note_tags tables — created by db.create_all() on fresh DBs,
        # but existing Vercel deployments need explicit CREATE TABLE IF NOT EXISTS
        ("""CREATE TABLE IF NOT EXISTS tag (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
            name VARCHAR(60) NOT NULL,
            color VARCHAR(7) NOT NULL DEFAULT '#5a7c50',
            UNIQUE(user_id, name)
        )""",),
        ("""CREATE TABLE IF NOT EXISTS note_tags (
            note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
            tag_id  INTEGER NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
            PRIMARY KEY (note_id, tag_id)
        )""",),
    ]
    for (sql,) in migrations:
        _run_migration(sql)
    _db_initialised = True

def _run_migration(sql):
    try:
        with db.engine.connect() as conn:
            conn.execute(db.text(sql))
            conn.commit()
    except Exception as e:
        err = str(e).lower()
        # Ignore "already exists" errors — idempotent migrations
        if any(p in err for p in (
            "already exists", "duplicate column", "duplicate object",
            "42701",   # PostgreSQL duplicate_column
            "42p07",   # PostgreSQL duplicate_table
            "column",
        )):
            pass
        else:
            raise

@app.before_request
def _before():
    if request.path == "/favicon.ico":
        return
    ensure_db()
    if current_user.is_authenticated:
        _purge_expired_trash()

from sqlalchemy.exc import OperationalError, DatabaseError

@app.errorhandler(OperationalError)
@app.errorhandler(DatabaseError)
def _handle_db_error(e):
    db.session.rollback()
    detail = str(e.orig) if hasattr(e, "orig") else str(e)
    return jsonify({"error": "Database connection failed.", "detail": detail,
                    "hint": "Check DATABASE_URL is correct."}), 503

# ── Helpers ────────────────────────────────────────────────────────────────
_TAG_RE       = re.compile(r"<[^>]+>")
_BLOCK_END_RE = re.compile(r"</(p|div|h[1-6]|li|blockquote|pre)>", re.I)
_BR_RE        = re.compile(r"<br\s*/?>", re.I)
_EMAIL_RE     = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_HASHTAG_RE   = re.compile(r"(?<!\w)#([A-Za-z0-9_\u00C0-\u017E]{1,40})(?!\w)")


def _html_to_text(raw_html):
    if not raw_html: return ""
    text = _BLOCK_END_RE.sub("\n", raw_html)
    text = _BR_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    return "\n".join(ln.strip() for ln in text.split("\n") if ln.strip())


def _derive_title_snippet(raw_html):
    plain = _html_to_text(raw_html)
    if not plain: return "New Note", "", ""
    parts   = plain.split("\n", 1)
    title   = parts[0][:255].strip() or "New Note"
    rest    = parts[1].strip() if len(parts) > 1 else ""
    snippet = re.sub(r"\s+", " ", rest)[:280]
    return title, snippet, plain


def _extract_hashtags(plain_text):
    """Return lowercase tag names found as #hashtags in plain text."""
    return list({m.group(1).lower() for m in _HASHTAG_RE.finditer(plain_text or "")})


def _sync_note_tags(note, tag_names):
    """
    Sync note's tags using raw SQL on note_tags.
    Never uses ORM relationship append/remove so SQLAlchemy's identity map
    cannot bleed tags across notes sharing the same session.
    """
    if not tag_names:
        # Remove all tags from this note
        db.session.execute(
            db.text("DELETE FROM note_tags WHERE note_id = :nid"),
            {"nid": note.id}
        )
        return

    desired = set(t.lower().strip() for t in tag_names if t.strip())

    # Ensure each desired tag exists for this user
    tag_ids = []
    for name in desired:
        tag = Tag.query.filter_by(user_id=note.user_id, name=name).first()
        if not tag:
            tag = Tag(user_id=note.user_id, name=name)
            db.session.add(tag)
            db.session.flush()
        tag_ids.append(tag.id)

    # Get current tag_ids for this note via raw SQL
    rows = db.session.execute(
        db.text("SELECT tag_id FROM note_tags WHERE note_id = :nid"),
        {"nid": note.id}
    ).fetchall()
    current_ids = {r[0] for r in rows}

    # Remove tags no longer desired
    to_remove = current_ids - set(tag_ids)
    for tid in to_remove:
        db.session.execute(
            db.text("DELETE FROM note_tags WHERE note_id = :nid AND tag_id = :tid"),
            {"nid": note.id, "tid": tid}
        )

    # Add new tags not yet linked
    to_add = set(tag_ids) - current_ids
    for tid in to_add:
        try:
            db.session.execute(
                db.text("INSERT INTO note_tags (note_id, tag_id) VALUES (:nid, :tid)"),
                {"nid": note.id, "tid": tid}
            )
        except Exception:
            db.session.rollback()


def _set_note_tags_by_ids(note_id, tag_ids, user_id):
    """
    Explicitly set a note's tags to exactly the given tag_id list.
    Uses raw SQL only — zero ORM relationship writes.
    """
    # Verify all tag_ids belong to this user
    valid = {t.id for t in Tag.query.filter(
        Tag.id.in_(tag_ids), Tag.user_id == user_id).all()} if tag_ids else set()

    # Delete all current associations for this note
    db.session.execute(
        db.text("DELETE FROM note_tags WHERE note_id = :nid"),
        {"nid": note_id}
    )
    # Insert the desired ones
    for tid in valid:
        try:
            db.session.execute(
                db.text("INSERT INTO note_tags (note_id, tag_id) VALUES (:nid, :tid)"),
                {"nid": note_id, "tid": tid}
            )
        except Exception:
            db.session.rollback()


def _get_default_folder(user_id):
    folder = Folder.query.filter_by(user_id=user_id, is_default=True).first()
    if not folder:
        folder = Folder(user_id=user_id, name="Notes", is_default=True)
        db.session.add(folder)
        db.session.commit()
    return folder


def _purge_expired_trash():
    cutoff  = utcnow() - timedelta(days=TRASH_RETENTION_DAYS)
    expired = Note.query.filter(Note.is_deleted.is_(True), Note.deleted_at < cutoff).all()
    for n in expired: db.session.delete(n)
    if expired: db.session.commit()


def _api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({"error": "Login required"}), 401
        return f(*args, **kwargs)
    return decorated


def _admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin_logged_in"):
            return jsonify({"error": "Admin login required"}), 401
        return f(*args, **kwargs)
    return decorated


def _own_note(note_id):
    return Note.query.filter_by(id=note_id, user_id=current_user.id).first_or_404()


def _own_folder(folder_id):
    return Folder.query.filter_by(id=folder_id, user_id=current_user.id).first_or_404()


def _gen_share_token():
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(32))


# ── Auth ───────────────────────────────────────────────────────────────────
@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not _EMAIL_RE.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "An account with that email already exists."}), 409
    user = User(email=email, username=email.split("@")[0])
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    _get_default_folder(user.id)
    login_user(user, remember=True)
    return jsonify({"ok": True, "user": user.to_dict()}), 201


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    identifier = (data.get("email") or "").strip().lower()
    password   = data.get("password") or ""
    if not identifier:
        return jsonify({"error": "Email or username is required."}), 400
    if not password:
        return jsonify({"error": "Password is required."}), 400
    user = User.query.filter_by(email=identifier).first()
    if not user:
        user = User.query.filter(db.func.lower(User.username) == identifier).first()
    if not user and not identifier.endswith("@admin.local"):
        user = User.query.filter_by(email=identifier + "@admin.local").first()
    if not user or not user.check_password(password):
        return jsonify({"error": "Incorrect email or password."}), 401
    if not user.is_enabled:
        return jsonify({"error": "This account has been disabled."}), 403
    login_user(user, remember=True)
    return jsonify({"ok": True, "user": user.to_dict()})


@app.route("/api/auth/logout", methods=["POST"])
@_api_login_required
def api_logout():
    logout_user()
    return jsonify({"ok": True})


@app.route("/api/auth/change-password", methods=["POST"])
def api_change_password():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    new_pwd = data.get("new_password") or ""
    if not _EMAIL_RE.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(new_pwd) < 8:
        return jsonify({"error": "New password must be at least 8 characters."}), 400
    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({"ok": True, "message": "If that email is registered, your password has been updated."})
    user.set_password(new_pwd)
    db.session.commit()
    return jsonify({"ok": True, "message": "Password updated. You can now log in."})


@app.route("/api/auth/me")
def api_me():
    if current_user.is_authenticated:
        return jsonify({"logged_in": True, "user": current_user.to_dict()})
    return jsonify({"logged_in": False})


# ── Admin auth ─────────────────────────────────────────────────────────────
@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json(silent=True) or {}
    if data.get("uid") == ADMIN_UID and data.get("password") == ADMIN_PASSWORD:
        session["admin_logged_in"] = True
        session.permanent = True
        return jsonify({"ok": True})
    return jsonify({"error": "Invalid admin credentials."}), 401


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    session.pop("admin_logged_in", None)
    return jsonify({"ok": True})


@app.route("/api/admin/me")
def api_admin_me():
    return jsonify({"logged_in": bool(session.get("admin_logged_in"))})


@app.route("/api/admin/users")
@_admin_required
def api_admin_list_users():
    q = (request.args.get("q") or "").strip()
    query = User.query
    if q:
        like = f"%{q}%"
        query = query.filter(db.or_(User.username.ilike(like), User.email.ilike(like)))
    return jsonify([u.to_admin_dict() for u in query.order_by(User.created_at.desc()).all()])


@app.route("/api/admin/users", methods=["POST"])
@_admin_required
def api_admin_create_user():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username:
        return jsonify({"error": "Username is required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    fake_email = f"{username}@admin.local"
    if User.query.filter(db.or_(User.username == username, User.email == fake_email)).first():
        return jsonify({"error": f'Username "{username}" is already taken.'}), 409
    user = User(username=username, email=fake_email, is_enabled=True)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    _get_default_folder(user.id)
    return jsonify(user.to_admin_dict()), 201


@app.route("/api/admin/users/<int:user_id>", methods=["PATCH"])
@_admin_required
def api_admin_update_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found."}), 404
    data = request.get_json(silent=True) or {}
    if "username" in data:
        new_name = (data["username"] or "").strip()
        if not new_name:
            return jsonify({"error": "Username cannot be empty."}), 400
        if User.query.filter(User.username == new_name, User.id != user_id).first():
            return jsonify({"error": f'Username "{new_name}" is already taken.'}), 409
        user.username = new_name
    if "password" in data:
        new_pwd = data["password"] or ""
        if len(new_pwd) < 6:
            return jsonify({"error": "Password must be at least 6 characters."}), 400
        user.set_password(new_pwd)
    if "is_enabled" in data:
        user.is_enabled = bool(data["is_enabled"])
    db.session.commit()
    return jsonify(user.to_admin_dict())


@app.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@_admin_required
def api_admin_delete_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found."}), 404
    Note.query.filter_by(user_id=user.id).delete()
    Folder.query.filter_by(user_id=user.id).delete()
    db.session.delete(user)
    db.session.commit()
    return jsonify({"ok": True})


# ── Tags ───────────────────────────────────────────────────────────────────
@app.route("/api/tags")
@_api_login_required
def api_list_tags():
    tags = Tag.query.filter_by(user_id=current_user.id).order_by(Tag.name).all()
    return jsonify([t.to_dict() for t in tags])


@app.route("/api/tags", methods=["POST"])
@_api_login_required
def api_create_tag():
    data  = request.get_json(silent=True) or {}
    name  = (data.get("name") or "").strip().lower()
    color = data.get("color") or "#5a7c50"
    if not name:
        return jsonify({"error": "Tag name is required."}), 400
    if Tag.query.filter_by(user_id=current_user.id, name=name).first():
        return jsonify({"error": f'Tag "{name}" already exists.'}), 409
    tag = Tag(user_id=current_user.id, name=name, color=color)
    db.session.add(tag)
    db.session.commit()
    return jsonify(tag.to_dict()), 201


@app.route("/api/tags/<int:tag_id>", methods=["PATCH"])
@_api_login_required
def api_update_tag(tag_id):
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id).first_or_404()
    data = request.get_json(silent=True) or {}
    if "name"  in data: tag.name  = (data["name"] or "").strip().lower()
    if "color" in data: tag.color = data["color"]
    db.session.commit()
    return jsonify(tag.to_dict())


@app.route("/api/tags/<int:tag_id>", methods=["DELETE"])
@_api_login_required
def api_delete_tag(tag_id):
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id).first_or_404()
    db.session.delete(tag)
    db.session.commit()
    return jsonify({"ok": True})


# ── Pages ──────────────────────────────────────────────────────────────────
@app.route("/favicon.ico")
def favicon(): return ("", 204)

@app.route("/")
def login_page(): return render_template("login.html")

@app.route("/notes")
@login_required
def notes_page(): return render_template("index.html")

@app.route("/Admin")
def admin_page(): return render_template("admin.html")

@app.route("/share/<token>")
def public_share(token):
    note = Note.query.filter_by(share_token=token).first_or_404()
    if note.share_expires and note.share_expires < utcnow():
        return render_template("share_expired.html"), 410
    return render_template("share.html", note=note)


# ── Sidebar ────────────────────────────────────────────────────────────────
@app.route("/api/sidebar")
@_api_login_required
def api_sidebar():
    _get_default_folder(current_user.id)
    folders = Folder.query.filter_by(user_id=current_user.id).order_by(
        Folder.is_default.desc(), Folder.sort_order.asc(), Folder.name.asc()).all()
    # Build tree ordered by parent_id / sort_order
    folder_map = {f.id: f.to_dict() for f in folders}
    # annotate depth
    def depth(f_id, seen=None):
        seen = seen or set()
        if f_id in seen: return 0
        seen.add(f_id)
        fd = folder_map.get(f_id, {})
        if not fd.get("parent_id"): return 0
        return 1 + depth(fd["parent_id"], seen)
    for fid in folder_map:
        folder_map[fid]["depth"] = depth(fid)
    tags = Tag.query.filter_by(user_id=current_user.id).order_by(Tag.name).all()
    favs = Note.query.filter_by(user_id=current_user.id, is_favorite=True, is_deleted=False).count()
    return jsonify({
        "folders":         list(folder_map.values()),
        "all_notes_count": Note.query.filter_by(user_id=current_user.id, is_deleted=False).count(),
        "trash_count":     Note.query.filter_by(user_id=current_user.id, is_deleted=True).count(),
        "favorites_count": favs,
        "tags":            [t.to_dict() for t in tags],
    })


# ── Folders ────────────────────────────────────────────────────────────────
@app.route("/api/folders", methods=["POST"])
@_api_login_required
def api_create_folder():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip() or "New Folder"
    parent_id = data.get("parent_id")
    if parent_id:
        _own_folder(parent_id)  # verify ownership
    folder = Folder(user_id=current_user.id, name=name, parent_id=parent_id or None)
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict()), 201


@app.route("/api/folders/<int:folder_id>", methods=["PATCH"])
@_api_login_required
def api_rename_folder(folder_id):
    folder = _own_folder(folder_id)
    data = request.get_json(silent=True) or {}
    if "name"      in data and data["name"]:   folder.name = data["name"].strip()
    if "parent_id" in data:                    folder.parent_id = data["parent_id"] or None
    if "sort_order"in data:                    folder.sort_order = int(data["sort_order"])
    db.session.commit()
    return jsonify(folder.to_dict())


@app.route("/api/folders/<int:folder_id>", methods=["DELETE"])
@_api_login_required
def api_delete_folder(folder_id):
    folder = _own_folder(folder_id)
    if folder.is_default:
        return jsonify({"error": "The Notes folder can't be deleted."}), 400
    fallback = _get_default_folder(current_user.id)
    # Move all notes (including from subfolders) to fallback
    def collect_ids(f):
        ids = [f.id]
        for c in Folder.query.filter_by(parent_id=f.id).all():
            ids += collect_ids(c)
        return ids
    for fid in collect_ids(folder):
        Note.query.filter_by(folder_id=fid).update({"folder_id": fallback.id})
        if fid != folder.id:
            sf = db.session.get(Folder, fid)
            if sf: db.session.delete(sf)
    db.session.delete(folder)
    db.session.commit()
    return jsonify({"ok": True, "moved_to": fallback.id})


# ── Notes: list ────────────────────────────────────────────────────────────
@app.route("/api/notes")
@_api_login_required
def api_list_notes():
    folder_param  = request.args.get("folder", "all")
    query_text    = (request.args.get("q") or "").strip()
    tag_filter    = (request.args.get("tag") or "").strip().lower()
    date_from_str = (request.args.get("date_from") or "").strip()
    date_to_str   = (request.args.get("date_to") or "").strip()
    favorite_only = request.args.get("favorite") == "1"

    query = Note.query.filter_by(user_id=current_user.id)

    if folder_param == "trash":
        query = query.filter_by(is_deleted=True)
    else:
        query = query.filter_by(is_deleted=False)
        if favorite_only:
            query = query.filter_by(is_favorite=True)
        elif folder_param != "all":
            try:
                fid = int(folder_param)
                # include notes from subfolders
                def all_subfolder_ids(pid):
                    ids = [pid]
                    for c in Folder.query.filter_by(user_id=current_user.id, parent_id=pid).all():
                        ids += all_subfolder_ids(c.id)
                    return ids
                fids = all_subfolder_ids(fid)
                query = query.filter(Note.folder_id.in_(fids))
            except (ValueError, TypeError):
                pass

    if query_text:
        like = f"%{query_text}%"
        query = query.filter(db.or_(Note.title.ilike(like), Note.plain_text.ilike(like)))

    if tag_filter:
        query = query.filter(
            db.text("""EXISTS (
                SELECT 1 FROM note_tags nt
                JOIN tag t ON t.id = nt.tag_id
                WHERE nt.note_id = note.id
                  AND t.name = :tag_name
                  AND t.user_id = :uid
            )""").bindparams(tag_name=tag_filter, uid=current_user.id)
        )

    if date_from_str:
        try:
            df = datetime.strptime(date_from_str, "%Y-%m-%d")
            query = query.filter(Note.updated_at >= df)
        except ValueError:
            pass
    if date_to_str:
        try:
            dt = datetime.strptime(date_to_str, "%Y-%m-%d") + timedelta(days=1)
            query = query.filter(Note.updated_at < dt)
        except ValueError:
            pass

    notes = query.order_by(Note.sort_order.asc(), Note.updated_at.desc()).all()
    return jsonify([n.to_dict() for n in notes])


@app.route("/api/notes/<int:note_id>")
@_api_login_required
def api_get_note(note_id):
    return jsonify(_own_note(note_id).to_dict(full=True))


@app.route("/api/notes", methods=["POST"])
@_api_login_required
def api_create_note():
    data = request.get_json(silent=True) or {}
    folder_id = data.get("folder_id")
    folder = None
    if folder_id:
        folder = Folder.query.filter_by(id=folder_id, user_id=current_user.id).first()
    if not folder:
        folder = _get_default_folder(current_user.id)
    min_order = db.session.query(db.func.min(Note.sort_order)).filter_by(
        user_id=current_user.id).scalar() or 0
    note = Note(user_id=current_user.id, folder_id=folder.id,
                title="New Note", content="", plain_text="", snippet="",
                sort_order=min_order - 1)
    db.session.add(note)
    db.session.commit()
    return jsonify(note.to_dict(full=True)), 201


@app.route("/api/notes/<int:note_id>", methods=["PUT", "POST"])
@_api_login_required
def api_update_note(note_id):
    note = _own_note(note_id)
    if note.is_deleted:
        return jsonify({"error": "Recover this note before editing it."}), 400
    data = request.get_json(silent=True) or {}
    if "content" in data:
        content = data.get("content") or ""
        title, snippet, plain = _derive_title_snippet(content)
        note.content    = content
        note.snippet    = snippet
        note.plain_text = plain
        title_override  = (data.get("_title_override") or "").strip()
        note.title      = (title_override[:255] if title_override else title) or "New Note"
        # Hashtag auto-sync intentionally removed: calling _sync_note_tags here
        # overwrites manually-assigned tags with only the hashtags in the text,
        # causing every save to reset tags. Tags are set only via explicit tag_ids.
    if data.get("folder_id"):
        _own_folder(data["folder_id"])
        note.folder_id = data["folder_id"]
    if "tag_ids" in data:
        _set_note_tags_by_ids(note.id, data.get("tag_ids") or [], current_user.id)
    db.session.commit()
    return jsonify(note.to_dict(full=True))


@app.route("/api/notes/reorder", methods=["POST"])
@_api_login_required
def api_reorder_notes():
    data = request.get_json(silent=True) or {}
    for idx, nid in enumerate(data.get("ordered_ids", [])):
        Note.query.filter_by(id=nid, user_id=current_user.id).update({"sort_order": idx})
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/notes/<int:note_id>/pin", methods=["POST"])
@_api_login_required
def api_toggle_pin(note_id):
    note = _own_note(note_id)
    note.pinned = not note.pinned
    db.session.commit()
    return jsonify(note.to_dict())


@app.route("/api/notes/<int:note_id>/favorite", methods=["POST"])
@_api_login_required
def api_toggle_favorite(note_id):
    note = _own_note(note_id)
    note.is_favorite = not note.is_favorite
    db.session.commit()
    return jsonify(note.to_dict())


@app.route("/api/notes/<int:note_id>/move", methods=["POST"])
@_api_login_required
def api_move_note(note_id):
    note = _own_note(note_id)
    data = request.get_json(silent=True) or {}
    note.folder_id = _own_folder(data.get("folder_id")).id
    db.session.commit()
    return jsonify(note.to_dict())


@app.route("/api/notes/<int:note_id>", methods=["DELETE"])
@_api_login_required
def api_delete_note(note_id):
    note = _own_note(note_id)
    if note.is_deleted:
        db.session.delete(note)
        db.session.commit()
        return jsonify({"ok": True, "permanently_deleted": True})
    note.is_deleted = True
    note.deleted_at = utcnow()
    note.pinned     = False
    db.session.commit()
    return jsonify(note.to_dict())


@app.route("/api/notes/<int:note_id>/restore", methods=["POST"])
@_api_login_required
def api_restore_note(note_id):
    note = _own_note(note_id)
    note.is_deleted = False
    note.deleted_at = None
    db.session.commit()
    return jsonify(note.to_dict())


@app.route("/api/trash/empty", methods=["POST"])
@_api_login_required
def api_empty_trash():
    Note.query.filter_by(user_id=current_user.id, is_deleted=True).delete()
    db.session.commit()
    return jsonify({"ok": True})


# ── Share links ────────────────────────────────────────────────────────────
@app.route("/api/notes/<int:note_id>/share", methods=["POST"])
@_api_login_required
def api_share_note(note_id):
    note = _own_note(note_id)
    data = request.get_json(silent=True) or {}
    expiry_hours = data.get("expiry_hours")   # None = never
    if not note.share_token:
        note.share_token = _gen_share_token()
    note.share_expires = (utcnow() + timedelta(hours=int(expiry_hours))
                          if expiry_hours else None)
    db.session.commit()
    return jsonify({"ok": True, "token": note.share_token,
                    "url": f"/share/{note.share_token}",
                    "expires": note.share_expires.isoformat() + "Z" if note.share_expires else None})


@app.route("/api/notes/<int:note_id>/share", methods=["DELETE"])
@_api_login_required
def api_revoke_share(note_id):
    note = _own_note(note_id)
    note.share_token   = None
    note.share_expires = None
    db.session.commit()
    return jsonify({"ok": True})


# ── Export CSV + PDF ───────────────────────────────────────────────────────
@app.route("/api/export/csv")
@_api_login_required
def api_export_csv():
    folder_param = request.args.get("folder", "all")
    query = Note.query.filter_by(user_id=current_user.id, is_deleted=False)
    if folder_param not in ("all", "trash"):
        try:
            query = query.filter_by(folder_id=int(folder_param))
        except ValueError:
            pass
    notes = query.order_by(Note.pinned.desc(), Note.sort_order.asc(), Note.updated_at.desc()).all()
    output = io.StringIO()
    writer = csv.writer(output, quoting=csv.QUOTE_ALL)
    writer.writerow(["ID", "Title", "Folder", "Tags", "Pinned", "Favorite",
                     "Content (plain text)", "Created", "Updated"])
    for n in notes:
        writer.writerow([
            n.id, n.title or "",
            n.folder.name if n.folder else "",
            "|".join(t.name for t in n.tags),
            "Yes" if n.pinned else "No",
            "Yes" if n.is_favorite else "No",
            n.plain_text or "",
            n.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            n.updated_at.strftime("%Y-%m-%d %H:%M:%S"),
        ])
    return Response(output.getvalue().encode("utf-8-sig"), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=notes_export.csv"})


@app.route("/api/notes/<int:note_id>/export/pdf")
@_api_login_required
def api_export_note_pdf(note_id):
    note = _own_note(note_id)
    try:
        from weasyprint import HTML as WP_HTML
    except ImportError:
        return jsonify({"error": "PDF export requires weasyprint. Add it to requirements.txt."}), 501
    html_doc = render_template("pdf_note.html", note=note)
    pdf_bytes = WP_HTML(string=html_doc, base_url=request.host_url).write_pdf()
    safe_title = re.sub(r"[^\w\-]", "_", note.title or "note")[:60]
    return Response(pdf_bytes, mimetype="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename={safe_title}.pdf"})


# ── CSV import ─────────────────────────────────────────────────────────────
@app.route("/api/import/csv", methods=["POST"])
@_api_login_required
def api_import_csv():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded."}), 400
    try:
        text    = f.read().decode("utf-8-sig")
        reader  = csv.DictReader(io.StringIO(text))
        rows    = list(reader)
    except Exception as e:
        return jsonify({"error": f"Could not parse CSV: {e}"}), 400

    default_folder = _get_default_folder(current_user.id)
    created = skipped = 0
    folder_cache = {}

    for row in rows:
        title   = (row.get("Title") or row.get("title") or "").strip()
        body    = (row.get("Content (plain text)") or row.get("content") or
                   row.get("body") or row.get("Body") or "").strip()
        folder_name = (row.get("Folder") or row.get("folder") or "").strip()
        tag_str = (row.get("Tags") or row.get("tags") or "").strip()

        if not title and not body:
            skipped += 1
            continue

        # Find or create folder
        if folder_name:
            if folder_name not in folder_cache:
                fldr = Folder.query.filter_by(user_id=current_user.id, name=folder_name).first()
                if not fldr:
                    fldr = Folder(user_id=current_user.id, name=folder_name)
                    db.session.add(fldr)
                    db.session.flush()
                folder_cache[folder_name] = fldr
            folder = folder_cache[folder_name]
        else:
            folder = default_folder

        content = f"<p>{html.escape(title)}</p><p>{html.escape(body)}</p>" if body else f"<p>{html.escape(title)}</p>"
        _, snippet, plain = _derive_title_snippet(content)

        note = Note(user_id=current_user.id, folder_id=folder.id,
                    title=title[:255] or "Imported Note",
                    content=content, plain_text=plain, snippet=snippet)
        db.session.add(note)
        db.session.flush()

        if tag_str:
            tag_names = [t.strip().lower() for t in tag_str.split("|") if t.strip()]
            _sync_note_tags(note, tag_names)

        created += 1

    db.session.commit()
    return jsonify({"ok": True, "created": created, "skipped": skipped})


# ── Local dev ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5000)

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
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import (Flask, Response, jsonify, redirect, render_template,
                   request, session, url_for)
from flask_login import (LoginManager, UserMixin, current_user, login_required,
                         login_user, logout_user)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT         = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(ROOT, "templates")
STATIC_DIR   = os.path.join(ROOT, "static")

TRASH_RETENTION_DAYS = 30

# ── Superuser credentials (hardcoded as requested) ─────────────────────────
ADMIN_UID      = "superuser"
ADMIN_PASSWORD = "June021999"


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ── App ────────────────────────────────────────────────────────────────────
app = Flask(__name__,
            template_folder=TEMPLATE_DIR,
            static_folder=STATIC_DIR,
            static_url_path="/static")

_db_url = os.environ.get("DATABASE_URL", "")
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

_on_vercel = bool(os.environ.get("VERCEL"))

if not _db_url:
    if _on_vercel:
        raise RuntimeError(
            "DATABASE_URL is not set. On Vercel you must configure a Postgres "
            "database and set the DATABASE_URL environment variable "
            "(Project Settings -> Environment Variables), then redeploy."
        )
    _db_url = "sqlite:///" + os.path.join(ROOT, "notes.db")

app.config["SQLALCHEMY_DATABASE_URI"]        = _db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"]      = {
    "pool_pre_ping": True,
    "pool_recycle":  300,
    "connect_args":  {} if "sqlite" in _db_url else {"sslmode": "require"},
}

_secret_key = os.environ.get("SECRET_KEY")
if not _secret_key:
    if _on_vercel:
        raise RuntimeError(
            "SECRET_KEY is not set. On Vercel this MUST be a fixed value in "
            "your environment variables (Project Settings -> Environment "
            "Variables). Generate one with: "
            "python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    _secret_key = secrets.token_hex(32)

app.config["SECRET_KEY"]             = _secret_key
app.config["SESSION_COOKIE_SECURE"]  = _on_vercel
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["REMEMBER_COOKIE_SECURE"]  = _on_vercel
app.config["REMEMBER_COOKIE_HTTPONLY"] = True
app.config["REMEMBER_COOKIE_SAMESITE"] = "Lax"

db = SQLAlchemy(app)

login_manager = LoginManager(app)
login_manager.login_view    = "login_page"
login_manager.login_message = ""


# ── Models ─────────────────────────────────────────────────────────────────
class User(UserMixin, db.Model):
    __tablename__ = "user"
    id            = db.Column(db.Integer, primary_key=True)
    email         = db.Column(db.String(254), unique=True, nullable=False)
    username      = db.Column(db.String(80),  unique=True, nullable=True)
    password_hash = db.Column(db.String(256), nullable=False)
    is_enabled    = db.Column(db.Boolean, default=True,  nullable=False)
    created_at    = db.Column(db.DateTime, default=utcnow)

    def set_password(self, plain):
        self.password_hash = generate_password_hash(plain)

    def check_password(self, plain):
        return check_password_hash(self.password_hash, plain)

    def to_dict(self):
        return {"id": self.id, "email": self.email, "username": self.username}

    def to_admin_dict(self):
        return {
            "id":         self.id,
            "username":   self.username or self.email,
            "email":      self.email,
            "is_enabled": self.is_enabled,
            "created_at": self.created_at.strftime("%Y-%m-%d"),
        }


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


class Folder(db.Model):
    __tablename__ = "folder"
    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    name       = db.Column(db.String(120), nullable=False)
    is_default = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)
    notes      = db.relationship("Note", backref="folder", lazy=True,
                                  foreign_keys="Note.folder_id")

    def to_dict(self):
        count = Note.query.filter_by(folder_id=self.id, is_deleted=False).count()
        return {"id": self.id, "name": self.name,
                "is_default": self.is_default, "note_count": count}


class Note(db.Model):
    __tablename__ = "note"
    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    folder_id  = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=False)
    title      = db.Column(db.String(255), default="New Note")
    content    = db.Column(db.Text, default="")
    plain_text = db.Column(db.Text, default="")
    snippet    = db.Column(db.Text, default="")
    pinned     = db.Column(db.Boolean, default=False, nullable=False)
    is_deleted = db.Column(db.Boolean, default=False, nullable=False)
    sort_order = db.Column(db.Integer, default=0,     nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)
    deleted_at = db.Column(db.DateTime, nullable=True)

    def to_dict(self, full=False):
        d = {
            "id":         self.id,
            "folder_id":  self.folder_id,
            "title":      self.title or "New Note",
            "snippet":    self.snippet or "",
            "plain_text": self.plain_text or "",
            "pinned":     self.pinned,
            "is_deleted": self.is_deleted,
            "sort_order": self.sort_order,
            "created_at": self.created_at.isoformat() + "Z",
            "updated_at": self.updated_at.isoformat() + "Z",
        }
        if self.deleted_at:
            d["deleted_at"] = self.deleted_at.isoformat() + "Z"
        if full:
            d["content"] = self.content or ""
        return d


# ── DB init ────────────────────────────────────────────────────────────────
_db_initialised = False

def ensure_db():
    global _db_initialised
    if not _db_initialised:
        db.create_all()
        _db_initialised = True


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
    return jsonify({"error": "Could not connect to the database. Check DATABASE_URL."}), 503


# ── Helpers ────────────────────────────────────────────────────────────────
_TAG_RE       = re.compile(r"<[^>]+>")
_BLOCK_END_RE = re.compile(r"</(p|div|h[1-6]|li|blockquote|pre)>", re.I)
_BR_RE        = re.compile(r"<br\s*/?>", re.I)
_EMAIL_RE     = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _html_to_text(raw_html):
    if not raw_html:
        return ""
    text  = _BLOCK_END_RE.sub("\n", raw_html)
    text  = _BR_RE.sub("\n", text)
    text  = _TAG_RE.sub("", text)
    text  = html.unescape(text)
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    return "\n".join(lines)


def _derive_title_snippet(raw_html):
    plain = _html_to_text(raw_html)
    if not plain:
        return "New Note", "", ""
    parts   = plain.split("\n", 1)
    title   = parts[0][:255].strip() or "New Note"
    rest    = parts[1].strip() if len(parts) > 1 else ""
    snippet = re.sub(r"\s+", " ", rest)[:280]
    return title, snippet, plain


def _get_default_folder(user_id):
    folder = Folder.query.filter_by(user_id=user_id, is_default=True).first()
    if not folder:
        folder = Folder(user_id=user_id, name="Notes", is_default=True)
        db.session.add(folder)
        db.session.commit()
    return folder


def _purge_expired_trash():
    cutoff  = utcnow() - timedelta(days=TRASH_RETENTION_DAYS)
    expired = Note.query.filter(
        Note.is_deleted.is_(True), Note.deleted_at < cutoff).all()
    for n in expired:
        db.session.delete(n)
    if expired:
        db.session.commit()


def _api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({"error": "Login required"}), 401
        return f(*args, **kwargs)
    return decorated


def _admin_required(f):
    """Decorator: reject non-admin requests with 401 JSON."""
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


# ── User auth routes ───────────────────────────────────────────────────────
@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    data     = request.get_json(silent=True) or {}
    email    = (data.get("email") or "").strip().lower()
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
    data     = request.get_json(silent=True) or {}
    email    = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not _EMAIL_RE.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if not password:
        return jsonify({"error": "Password is required."}), 400
    user = User.query.filter_by(email=email).first()
    if not user or not user.check_password(password):
        return jsonify({"error": "Incorrect email or password."}), 401
    if not user.is_enabled:
        return jsonify({"error": "This account has been disabled. Contact an administrator."}), 403
    login_user(user, remember=True)
    return jsonify({"ok": True, "user": user.to_dict()})


@app.route("/api/auth/logout", methods=["POST"])
@_api_login_required
def api_logout():
    logout_user()
    return jsonify({"ok": True})


@app.route("/api/auth/change-password", methods=["POST"])
def api_change_password():
    data    = request.get_json(silent=True) or {}
    email   = (data.get("email") or "").strip().lower()
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


# ── Admin auth routes ──────────────────────────────────────────────────────
@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json(silent=True) or {}
    uid  = (data.get("uid") or "").strip()
    pwd  = data.get("password") or ""
    if uid == ADMIN_UID and pwd == ADMIN_PASSWORD:
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


# ── Admin user management API ──────────────────────────────────────────────
@app.route("/api/admin/users")
@_admin_required
def api_admin_list_users():
    q    = (request.args.get("q") or "").strip()
    query = User.query
    if q:
        like  = f"%{q}%"
        query = query.filter(db.or_(
            User.username.ilike(like),
            User.email.ilike(like),
        ))
    users = query.order_by(User.created_at.desc()).all()
    return jsonify([u.to_admin_dict() for u in users])


@app.route("/api/admin/users", methods=["POST"])
@_admin_required
def api_admin_create_user():
    data     = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username:
        return jsonify({"error": "Username is required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    # Use username as both username and a synthetic email
    fake_email = f"{username}@admin.local"
    if User.query.filter(db.or_(
            User.username == username,
            User.email == fake_email)).first():
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
        clash = User.query.filter(User.username == new_name, User.id != user_id).first()
        if clash:
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
    # Delete all notes and folders owned by user first
    Note.query.filter_by(user_id=user.id).delete()
    Folder.query.filter_by(user_id=user.id).delete()
    db.session.delete(user)
    db.session.commit()
    return jsonify({"ok": True})


# ── Pages ──────────────────────────────────────────────────────────────────
@app.route("/favicon.ico")
def favicon():
    return ("", 204)


@app.route("/")
def login_page():
    return render_template("login.html")


@app.route("/notes")
@login_required
def notes_page():
    return render_template("index.html")


@app.route("/Admin")
def admin_page():
    return render_template("admin.html")


# ── Sidebar ────────────────────────────────────────────────────────────────
@app.route("/api/sidebar")
@_api_login_required
def api_sidebar():
    _get_default_folder(current_user.id)
    folders = Folder.query.filter_by(user_id=current_user.id).order_by(
        Folder.is_default.desc(), Folder.name.asc()).all()
    return jsonify({
        "folders":         [f.to_dict() for f in folders],
        "all_notes_count": Note.query.filter_by(user_id=current_user.id, is_deleted=False).count(),
        "trash_count":     Note.query.filter_by(user_id=current_user.id, is_deleted=True).count(),
    })


@app.route("/api/folders", methods=["POST"])
@_api_login_required
def api_create_folder():
    data   = request.get_json(silent=True) or {}
    name   = (data.get("name") or "").strip() or "New Folder"
    folder = Folder(user_id=current_user.id, name=name)
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict()), 201


@app.route("/api/folders/<int:folder_id>", methods=["PATCH"])
@_api_login_required
def api_rename_folder(folder_id):
    folder = _own_folder(folder_id)
    data   = request.get_json(silent=True) or {}
    name   = (data.get("name") or "").strip()
    if name:
        folder.name = name
        db.session.commit()
    return jsonify(folder.to_dict())


@app.route("/api/folders/<int:folder_id>", methods=["DELETE"])
@_api_login_required
def api_delete_folder(folder_id):
    folder   = _own_folder(folder_id)
    if folder.is_default:
        return jsonify({"error": "The Notes folder can't be deleted."}), 400
    fallback = _get_default_folder(current_user.id)
    Note.query.filter_by(folder_id=folder.id).update({"folder_id": fallback.id})
    db.session.delete(folder)
    db.session.commit()
    return jsonify({"ok": True, "moved_to": fallback.id})


# ── Notes ──────────────────────────────────────────────────────────────────
@app.route("/api/notes")
@_api_login_required
def api_list_notes():
    folder_param = request.args.get("folder", "all")
    query_text   = (request.args.get("q") or "").strip()
    query        = Note.query.filter_by(user_id=current_user.id)
    if folder_param == "trash":
        query = query.filter_by(is_deleted=True)
    else:
        query = query.filter_by(is_deleted=False)
        if folder_param != "all":
            try:
                query = query.filter_by(folder_id=int(folder_param))
            except ValueError:
                pass
    if query_text:
        like  = f"%{query_text}%"
        query = query.filter(db.or_(Note.title.ilike(like), Note.plain_text.ilike(like)))
    notes = query.order_by(Note.sort_order.asc(), Note.updated_at.desc()).all()
    return jsonify([n.to_dict() for n in notes])


@app.route("/api/notes/<int:note_id>")
@_api_login_required
def api_get_note(note_id):
    return jsonify(_own_note(note_id).to_dict(full=True))


@app.route("/api/notes", methods=["POST"])
@_api_login_required
def api_create_note():
    data      = request.get_json(silent=True) or {}
    folder_id = data.get("folder_id")
    folder    = None
    if folder_id:
        folder = Folder.query.filter_by(id=folder_id, user_id=current_user.id).first()
    if not folder:
        folder = _get_default_folder(current_user.id)
    min_order = db.session.query(db.func.min(Note.sort_order)).filter_by(
        user_id=current_user.id).scalar() or 0
    note = Note(user_id=current_user.id, folder_id=folder.id,
                title="New Note", content="", plain_text="",
                snippet="", sort_order=min_order - 1)
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
        content               = data.get("content") or ""
        title, snippet, plain = _derive_title_snippet(content)
        note.content          = content
        note.snippet          = snippet
        note.plain_text       = plain
        title_override        = (data.get("_title_override") or "").strip()
        note.title            = (title_override[:255] if title_override else title) or "New Note"
    if data.get("folder_id"):
        _own_folder(data["folder_id"])
        note.folder_id = data["folder_id"]
    db.session.commit()
    return jsonify(note.to_dict(full=True))


@app.route("/api/notes/reorder", methods=["POST"])
@_api_login_required
def api_reorder_notes():
    data        = request.get_json(silent=True) or {}
    ordered_ids = data.get("ordered_ids", [])
    for idx, nid in enumerate(ordered_ids):
        Note.query.filter_by(id=nid, user_id=current_user.id).update({"sort_order": idx})
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/notes/<int:note_id>/pin", methods=["POST"])
@_api_login_required
def api_toggle_pin(note_id):
    note        = _own_note(note_id)
    note.pinned = not note.pinned
    db.session.commit()
    return jsonify(note.to_dict())


@app.route("/api/notes/<int:note_id>/move", methods=["POST"])
@_api_login_required
def api_move_note(note_id):
    note           = _own_note(note_id)
    data           = request.get_json(silent=True) or {}
    folder         = _own_folder(data.get("folder_id"))
    note.folder_id = folder.id
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
    note            = _own_note(note_id)
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


# ── Export ─────────────────────────────────────────────────────────────────
@app.route("/api/export/csv")
@_api_login_required
def api_export_csv():
    folder_param = request.args.get("folder", "all")
    query        = Note.query.filter_by(user_id=current_user.id, is_deleted=False)
    if folder_param not in ("all", "trash"):
        try:
            query = query.filter_by(folder_id=int(folder_param))
        except ValueError:
            pass
    notes  = query.order_by(
        Note.pinned.desc(), Note.sort_order.asc(), Note.updated_at.desc()).all()
    output = io.StringIO()
    writer = csv.writer(output, quoting=csv.QUOTE_ALL)
    writer.writerow(["ID", "Title", "Folder", "Pinned",
                     "Content (plain text)", "Created", "Updated"])
    for n in notes:
        writer.writerow([
            n.id, n.title or "",
            n.folder.name if n.folder else "",
            "Yes" if n.pinned else "No",
            n.plain_text or "",
            n.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            n.updated_at.strftime("%Y-%m-%d %H:%M:%S"),
        ])
    csv_bytes = output.getvalue().encode("utf-8-sig")
    return Response(csv_bytes, mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=notes_export.csv"})


# ── Local dev ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5000)

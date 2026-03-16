# database.py
# ─────────────────────────────────────────────────────────────
# All database logic for ZenPin.
# Uses SQLite — stored in a single file called  zenpin.db
#
# Tables:
#   users       — accounts
#   ideas       — all idea posts
#   saves       — which user saved which idea
#   likes       — which user liked which idea
#   boards      — user-created collections
#   board_ideas — which ideas belong to which board
# ─────────────────────────────────────────────────────────────

import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "zenpin.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables. Safe to call multiple times."""
    conn = get_connection()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            email         TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            avatar_url    TEXT    DEFAULT NULL,
            bio           TEXT    DEFAULT '',
            created_at    TEXT    DEFAULT (datetime('now'))
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS ideas (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            title       TEXT    NOT NULL,
            description TEXT    DEFAULT '',
            category    TEXT    NOT NULL,
            image_url   TEXT    NOT NULL,
            difficulty  INTEGER DEFAULT 3,
            creativity  INTEGER DEFAULT 3,
            usefulness  INTEGER DEFAULT 3,
            saves_count INTEGER DEFAULT 0,
            likes_count INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now'))
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS saves (
            user_id  INTEGER NOT NULL REFERENCES users(id),
            idea_id  INTEGER NOT NULL REFERENCES ideas(id),
            saved_at TEXT    DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, idea_id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS likes (
            user_id  INTEGER NOT NULL REFERENCES users(id),
            idea_id  INTEGER NOT NULL REFERENCES ideas(id),
            liked_at TEXT    DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, idea_id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS boards (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            name        TEXT    NOT NULL,
            description TEXT    DEFAULT '',
            is_collab   INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now'))
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS board_ideas (
            board_id   INTEGER NOT NULL REFERENCES boards(id),
            idea_id    INTEGER NOT NULL REFERENCES ideas(id),
            added_at   TEXT    DEFAULT (datetime('now')),
            PRIMARY KEY (board_id, idea_id)
        )
    """)

    conn.commit()
    conn.close()
    print("✅ Database ready — zenpin.db")


# ── USERS ──────────────────────────────────────────────────────

def create_user(username, email, password_hash):
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO users (username,email,password_hash) VALUES (?,?,?)",
            (username, email, password_hash)
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone())
    finally:
        conn.close()

def get_user_by_email(email):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def get_user_by_id(user_id):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id,username,email,avatar_url,bio,created_at FROM users WHERE id=?",
            (user_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def update_user_profile(user_id, bio=None, avatar_url=None):
    conn = get_connection()
    try:
        if bio is not None:
            conn.execute("UPDATE users SET bio=? WHERE id=?", (bio, user_id))
        if avatar_url is not None:
            conn.execute("UPDATE users SET avatar_url=? WHERE id=?", (avatar_url, user_id))
        conn.commit()
        return get_user_by_id(user_id)
    finally:
        conn.close()


# ── IDEAS ───────────────────────────────────────────────────────

def create_idea(user_id, title, description, category, image_url, difficulty, creativity, usefulness):
    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO ideas
               (user_id,title,description,category,image_url,difficulty,creativity,usefulness)
               VALUES (?,?,?,?,?,?,?,?)""",
            (user_id, title, description, category, image_url, difficulty, creativity, usefulness)
        )
        conn.commit()
        return get_idea_by_id(cur.lastrowid)
    finally:
        conn.close()

def get_idea_by_id(idea_id):
    conn = get_connection()
    try:
        row = conn.execute(
            """SELECT i.*, u.username, u.avatar_url as author_avatar
               FROM ideas i JOIN users u ON i.user_id=u.id WHERE i.id=?""",
            (idea_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def get_ideas(category=None, search=None, sort="newest", limit=20, offset=0):
    conn = get_connection()
    try:
        where, params = [], []
        if category and category != "all":
            where.append("i.category=?"); params.append(category)
        if search:
            where.append("(i.title LIKE ? OR i.category LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        order_sql = {
            "newest":   "i.created_at DESC",
            "saves":    "i.saves_count DESC",
            "trending": "i.saves_count+i.likes_count DESC",
        }.get(sort, "i.created_at DESC")
        rows = conn.execute(
            f"""SELECT i.*, u.username, u.avatar_url as author_avatar
                FROM ideas i JOIN users u ON i.user_id=u.id
                {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?""",
            params + [limit, offset]
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def get_ideas_by_user(user_id):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM ideas WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def delete_idea(idea_id, user_id):
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM ideas WHERE id=? AND user_id=?", (idea_id, user_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── SAVES ───────────────────────────────────────────────────────

def save_idea(user_id, idea_id):
    conn = get_connection()
    try:
        exists = conn.execute(
            "SELECT 1 FROM saves WHERE user_id=? AND idea_id=?", (user_id, idea_id)
        ).fetchone()
        if exists:
            conn.execute("DELETE FROM saves WHERE user_id=? AND idea_id=?", (user_id, idea_id))
            conn.execute("UPDATE ideas SET saves_count=MAX(0,saves_count-1) WHERE id=?", (idea_id,))
            conn.commit()
            return False
        conn.execute("INSERT INTO saves (user_id,idea_id) VALUES (?,?)", (user_id, idea_id))
        conn.execute("UPDATE ideas SET saves_count=saves_count+1 WHERE id=?", (idea_id,))
        conn.commit()
        return True
    finally:
        conn.close()

def get_saved_ideas(user_id):
    conn = get_connection()
    try:
        rows = conn.execute(
            """SELECT i.*, u.username FROM ideas i
               JOIN saves s ON i.id=s.idea_id JOIN users u ON i.user_id=u.id
               WHERE s.user_id=? ORDER BY s.saved_at DESC""",
            (user_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def get_user_saves_set(user_id):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT idea_id FROM saves WHERE user_id=?", (user_id,)).fetchall()
        return {r["idea_id"] for r in rows}
    finally:
        conn.close()


# ── LIKES ───────────────────────────────────────────────────────

def like_idea(user_id, idea_id):
    conn = get_connection()
    try:
        exists = conn.execute(
            "SELECT 1 FROM likes WHERE user_id=? AND idea_id=?", (user_id, idea_id)
        ).fetchone()
        if exists:
            conn.execute("DELETE FROM likes WHERE user_id=? AND idea_id=?", (user_id, idea_id))
            conn.execute("UPDATE ideas SET likes_count=MAX(0,likes_count-1) WHERE id=?", (idea_id,))
            conn.commit()
            return False
        conn.execute("INSERT INTO likes (user_id,idea_id) VALUES (?,?)", (user_id, idea_id))
        conn.execute("UPDATE ideas SET likes_count=likes_count+1 WHERE id=?", (idea_id,))
        conn.commit()
        return True
    finally:
        conn.close()

def get_user_likes_set(user_id):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT idea_id FROM likes WHERE user_id=?", (user_id,)).fetchall()
        return {r["idea_id"] for r in rows}
    finally:
        conn.close()


# ── BOARDS ──────────────────────────────────────────────────────

def create_board(user_id, name, description="", is_collab=False):
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO boards (user_id,name,description,is_collab) VALUES (?,?,?,?)",
            (user_id, name, description, int(is_collab))
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM boards WHERE id=?", (cur.lastrowid,)).fetchone())
    finally:
        conn.close()

def get_boards_by_user(user_id):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM boards WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
        boards = []
        for r in rows:
            board = dict(r)
            cnt = conn.execute(
                "SELECT COUNT(*) as cnt FROM board_ideas WHERE board_id=?", (r["id"],)
            ).fetchone()
            board["idea_count"] = cnt["cnt"]
            previews = conn.execute(
                """SELECT i.image_url FROM ideas i
                   JOIN board_ideas bi ON i.id=bi.idea_id
                   WHERE bi.board_id=? LIMIT 4""", (r["id"],)
            ).fetchall()
            board["preview_images"] = [p["image_url"] for p in previews]
            boards.append(board)
        return boards
    finally:
        conn.close()

def add_idea_to_board(board_id, idea_id, user_id):
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT 1 FROM boards WHERE id=? AND user_id=?", (board_id, user_id)
        ).fetchone():
            return False
        conn.execute(
            "INSERT OR IGNORE INTO board_ideas (board_id,idea_id) VALUES (?,?)",
            (board_id, idea_id)
        )
        conn.commit()
        return True
    finally:
        conn.close()


# ── SEED ────────────────────────────────────────────────────────

def seed_demo_ideas():
    """Insert 20 starter ideas on first run. Skips if already seeded."""
    conn = get_connection()
    try:
        if conn.execute("SELECT COUNT(*) as cnt FROM ideas").fetchone()["cnt"] > 0:
            return
        from auth import hash_password
        conn.execute(
            "INSERT OR IGNORE INTO users (username,email,password_hash) VALUES (?,?,?)",
            ("zenpin_admin", "admin@zenpin.app", hash_password("admin123"))
        )
        conn.commit()
        admin_id = conn.execute(
            "SELECT id FROM users WHERE email='admin@zenpin.app'"
        ).fetchone()["id"]
        demo = [
            ("Japandi Living Room Refresh",     "Interior Design","https://images.unsplash.com/photo-1705321963943-de94bb3f0dd3?w=500&q=80",3,5,4),
            ("Minimal Oak Desk Setup",          "Workspace",      "https://images.unsplash.com/photo-1644337540803-2b2fb3cebf12?w=500&q=80",2,4,5),
            ("Brutalist Concrete Staircase",    "Architecture",   "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500&q=80",4,5,2),
            ("Curved Plaster Arch Alcove",      "Interior Design","https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=500&q=80",5,5,3),
            ("Generative Geometry Study #12",   "Art",            "https://images.unsplash.com/photo-1476357471311-43c0db9fb2b4?w=500&q=80",3,5,2),
            ("Textural Linen Layering",         "Fashion",        "https://images.unsplash.com/photo-1543966888-7c1dc482a810?w=500&q=80",2,4,3),
            ("Sourdough Scoring Patterns",      "Food",           "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=500&q=80",3,4,5),
            ("Fjord Ferry Crossing at Dusk",    "Travel",         "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=500&q=80",1,5,3),
            ("Ice Crystal Macro Study",         "Nature",         "https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=500&q=80",3,5,2),
            ("Circuit Board Abstraction",       "Tech",           "https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&q=80",4,4,4),
            ("Glass Tower Blue Hour",           "Architecture",   "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=500&q=80",2,5,2),
            ("Wabi-Sabi Earthy Bedroom",        "Interior Design","https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=500&q=80",3,5,4),
            ("Desert Dunes Golden Hour",        "Nature",         "https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=500&q=80",1,4,2),
            ("Ink Wash on Rice Paper",          "Art",            "https://images.unsplash.com/photo-1487014679447-9f8336841d58?w=500&q=80",4,5,2),
            ("Terracotta Ceramic Desk Accents", "Workspace",      "https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?w=500&q=80",2,4,4),
            ("Monochrome Editorial in Fog",     "Fashion",        "https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=500&q=80",3,5,2),
            ("Japanese Breakfast Bird's Eye",   "Food",           "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500&q=80",2,4,5),
            ("Narrow Streets of Old Lisbon",    "Travel",         "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&q=80",1,4,3),
            ("LED Neon Sign Workshop",          "Tech",           "https://images.unsplash.com/photo-1461695008884-244cb4543d74?w=500&q=80",4,5,3),
            ("Salt Flats Mirror at Sunset",     "Travel",         "https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5?w=500&q=80",1,5,2),
        ]
        for title,cat,img,d,cr,u in demo:
            conn.execute(
                "INSERT INTO ideas (user_id,title,category,image_url,difficulty,creativity,usefulness) VALUES (?,?,?,?,?,?,?)",
                (admin_id,title,cat,img,d,cr,u)
            )
        conn.commit()
        print(f"✅ Seeded {len(demo)} demo ideas")
    finally:
        conn.close()

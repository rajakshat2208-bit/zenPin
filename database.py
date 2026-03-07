# database.py — ZenPin v2.0
# ─────────────────────────────────────────────────────────────
# Tables:
#   users          — accounts
#   ideas          — posts (source: discovery | creator)
#   saves          — saves junction
#   likes          — likes junction
#   boards         — user collections
#   board_ideas    — board ↔ idea junction
#   discovery_cache— cached API image results (avoid repeat API calls)
# ─────────────────────────────────────────────────────────────

import sqlite3, os, json

_db_dir = "/tmp" if os.path.exists("/tmp") and os.access("/tmp", os.W_OK) else os.path.dirname(__file__)
DB_PATH = os.path.join(_db_dir, "zenpin.db")
os.makedirs(_db_dir, exist_ok=True)


def get_connection():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
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
            location      TEXT    DEFAULT '',
            social_links  TEXT    DEFAULT '{}',
            created_at    TEXT    DEFAULT (datetime('now'))
        )
    """)

    # Migrate existing installs
    for col, defn in [("location","TEXT DEFAULT ''"), ("social_links","TEXT DEFAULT '{}' ")]:
        try: c.execute(f"ALTER TABLE users ADD COLUMN {col} {defn}")
        except: pass

    # ── ideas: upgraded with source, steps, tools, cost, reference_links ──
    c.execute("""
        CREATE TABLE IF NOT EXISTS ideas (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          INTEGER NOT NULL REFERENCES users(id),
            title            TEXT    NOT NULL,
            description      TEXT    DEFAULT '',
            category         TEXT    NOT NULL,
            image_url        TEXT    NOT NULL,
            difficulty       INTEGER DEFAULT 3,
            creativity       INTEGER DEFAULT 3,
            usefulness       INTEGER DEFAULT 3,
            saves_count      INTEGER DEFAULT 0,
            likes_count      INTEGER DEFAULT 0,
            source           TEXT    DEFAULT 'creator',
            steps            TEXT    DEFAULT '[]',
            tools            TEXT    DEFAULT '[]',
            estimated_cost   TEXT    DEFAULT '',
            reference_links  TEXT    DEFAULT '[]',
            created_at       TEXT    DEFAULT (datetime('now'))
        )
    """)

    # Migrate existing tables that may not have new columns
    for col, definition in [
        ("source",          "TEXT DEFAULT 'creator'"),
        ("steps",           "TEXT DEFAULT '[]'"),
        ("tools",           "TEXT DEFAULT '[]'"),
        ("estimated_cost",  "TEXT DEFAULT ''"),
        ("reference_links", "TEXT DEFAULT '[]'"),
    ]:
        try:
            c.execute(f"ALTER TABLE ideas ADD COLUMN {col} {definition}")
        except Exception:
            pass  # Column already exists

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

    # ── Discovery cache — stores external API results to reduce calls ──
    c.execute("""
        CREATE TABLE IF NOT EXISTS discovery_cache (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            category   TEXT    NOT NULL,
            page       INTEGER DEFAULT 1,
            data       TEXT    NOT NULL,
            fetched_at TEXT    DEFAULT (datetime('now'))
        )
    """)
    c.execute("CREATE INDEX IF NOT EXISTS idx_cache_cat ON discovery_cache(category, page)")

    conn.commit()
    conn.close()
    print("✅ Database ready — zenpin.db v2.0")


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
    except sqlite3.IntegrityError as e:
        err = str(e).lower()
        if "username" in err: raise ValueError("username_taken")
        if "email"    in err: raise ValueError("email_taken")
        raise
    finally:
        conn.close()

def get_user_by_email(email):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def get_user_by_username(username):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def get_user_by_id(user_id):
    conn = get_connection()
    try:
        row = conn.execute(
            """SELECT id,username,email,avatar_url,bio,location,social_links,created_at
               FROM users WHERE id=?""",
            (user_id,)
        ).fetchone()
        if not row: return None
        d = dict(row)
        # Deserialise social_links JSON
        if isinstance(d.get("social_links"), str):
            try:    d["social_links"] = json.loads(d["social_links"])
            except: d["social_links"] = {}
        return d
    finally:
        conn.close()

def update_user_profile(user_id, bio=None, avatar_url=None, username=None,
                         location=None, social_links=None):
    conn = get_connection()
    try:
        updates = {}
        if bio          is not None: updates["bio"]          = bio
        if avatar_url   is not None: updates["avatar_url"]   = avatar_url
        if username     is not None: updates["username"]     = username
        if location     is not None: updates["location"]     = location
        if social_links is not None: updates["social_links"] = json.dumps(social_links)
        for col, val in updates.items():
            conn.execute(f"UPDATE users SET {col}=? WHERE id=?", (val, user_id))
        conn.commit()
        return get_user_by_id(user_id)
    finally:
        conn.close()


# ── USER STATS ─────────────────────────────────────────────────

def get_user_stats(user_id):
    """Return dashboard stats for a user."""
    conn = get_connection()
    try:
        posts  = conn.execute("SELECT COUNT(*) FROM ideas WHERE user_id=? AND source='creator'", (user_id,)).fetchone()[0]
        saves  = conn.execute("SELECT COUNT(*) FROM saves WHERE user_id=?", (user_id,)).fetchone()[0]
        likes  = conn.execute("SELECT COUNT(*) FROM likes WHERE user_id=?", (user_id,)).fetchone()[0]
        boards = conn.execute("SELECT COUNT(*) FROM boards WHERE user_id=?", (user_id,)).fetchone()[0]
        # Recent saves
        recent_saves = conn.execute(
            """SELECT i.*, u.username FROM ideas i
               JOIN saves s ON i.id=s.idea_id JOIN users u ON i.user_id=u.id
               WHERE s.user_id=? ORDER BY s.saved_at DESC LIMIT 6""",
            (user_id,)
        ).fetchall()
        # Recent uploads
        recent_uploads = conn.execute(
            "SELECT * FROM ideas WHERE user_id=? AND source='creator' ORDER BY created_at DESC LIMIT 6",
            (user_id,)
        ).fetchall()
        # Top categories saved
        cat_rows = conn.execute(
            """SELECT i.category, COUNT(*) as cnt FROM saves s
               JOIN ideas i ON s.idea_id=i.id WHERE s.user_id=?
               GROUP BY i.category ORDER BY cnt DESC LIMIT 5""",
            (user_id,)
        ).fetchall()
        return {
            "posts":           posts,
            "saves":           saves,
            "likes":           likes,
            "boards":          boards,
            "recent_saves":    [_parse_idea(r) for r in recent_saves],
            "recent_uploads":  [_parse_idea(r) for r in recent_uploads],
            "top_categories":  [{"category": r["category"], "count": r["cnt"]} for r in cat_rows],
        }
    finally:
        conn.close()


# ── IDEAS ───────────────────────────────────────────────────────

def _parse_idea(row):
    """Convert a Row to dict, deserialising JSON fields."""
    d = dict(row)
    for field in ("steps", "tools", "reference_links"):
        if isinstance(d.get(field), str):
            try:    d[field] = json.loads(d[field])
            except: d[field] = []
    return d

def create_idea(user_id, title, description, category, image_url,
                difficulty=3, creativity=3, usefulness=3,
                source="creator", steps=None, tools=None,
                estimated_cost="", reference_links=None):
    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO ideas
               (user_id,title,description,category,image_url,
                difficulty,creativity,usefulness,source,steps,tools,estimated_cost,reference_links)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (user_id, title, description, category, image_url,
             difficulty, creativity, usefulness, source,
             json.dumps(steps or []),
             json.dumps(tools or []),
             estimated_cost,
             json.dumps(reference_links or []))
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
        return _parse_idea(row) if row else None
    finally:
        conn.close()

def get_ideas(category=None, search=None, sort="newest",
              limit=20, offset=0, source=None):
    conn = get_connection()
    try:
        where, params = [], []
        if category and category != "all":
            where.append("i.category=?"); params.append(category)
        if search:
            where.append("(i.title LIKE ? OR i.category LIKE ? OR i.description LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        if source:
            where.append("i.source=?"); params.append(source)
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
        return [_parse_idea(r) for r in rows]
    finally:
        conn.close()

def get_ideas_by_user(user_id):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM ideas WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
        return [_parse_idea(r) for r in rows]
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
            conn.commit(); return False
        conn.execute("INSERT INTO saves (user_id,idea_id) VALUES (?,?)", (user_id, idea_id))
        conn.execute("UPDATE ideas SET saves_count=saves_count+1 WHERE id=?", (idea_id,))
        conn.commit(); return True
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
        return [_parse_idea(r) for r in rows]
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
            conn.commit(); return False
        conn.execute("INSERT INTO likes (user_id,idea_id) VALUES (?,?)", (user_id, idea_id))
        conn.execute("UPDATE ideas SET likes_count=likes_count+1 WHERE id=?", (idea_id,))
        conn.commit(); return True
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
        conn.commit(); return True
    finally:
        conn.close()


# ── DISCOVERY CACHE ─────────────────────────────────────────────

def get_cached_discovery(category, page=1, max_age_minutes=60):
    """Return cached discovery images if fresh enough."""
    conn = get_connection()
    try:
        row = conn.execute(
            """SELECT data FROM discovery_cache
               WHERE category=? AND page=?
               AND (julianday('now') - julianday(fetched_at)) * 1440 < ?""",
            (category.lower(), page, max_age_minutes)
        ).fetchone()
        return json.loads(row["data"]) if row else None
    finally:
        conn.close()

def set_cached_discovery(category, page, images):
    """Save discovery results to cache."""
    conn = get_connection()
    try:
        conn.execute(
            "DELETE FROM discovery_cache WHERE category=? AND page=?",
            (category.lower(), page)
        )
        conn.execute(
            "INSERT INTO discovery_cache (category,page,data) VALUES (?,?,?)",
            (category.lower(), page, json.dumps(images))
        )
        conn.commit()
    finally:
        conn.close()


# ── SEED ────────────────────────────────────────────────────────

def seed_demo_ideas():
    """Seed starter ideas across all new categories. Skips if already seeded."""
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
            # Interior Design
            ("Japandi Living Room Refresh",     "Interior Design", "https://images.unsplash.com/photo-1705321963943-de94bb3f0dd3?w=500&q=80", 3,5,4),
            ("Wabi-Sabi Earthy Bedroom",        "Interior Design", "https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=500&q=80",   3,5,4),
            ("Curved Plaster Arch Alcove",      "Interior Design", "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=500&q=80", 5,5,3),
            # Workspace
            ("Minimal Oak Desk Setup",          "Workspace",       "https://images.unsplash.com/photo-1644337540803-2b2fb3cebf12?w=500&q=80", 2,4,5),
            ("Terracotta Ceramic Desk Accents", "Workspace",       "https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?w=500&q=80",   2,4,4),
            # Architecture
            ("Brutalist Concrete Staircase",    "Architecture",    "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500&q=80",   4,5,2),
            ("Glass Tower Blue Hour",           "Architecture",    "https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=500&q=80", 2,5,2),
            # Art
            ("Generative Geometry Study #12",   "Art",             "https://images.unsplash.com/photo-1476357471311-43c0db9fb2b4?w=500&q=80", 3,5,2),
            ("Ink Wash on Rice Paper",          "Art",             "https://images.unsplash.com/photo-1487014679447-9f8336841d58?w=500&q=80", 4,5,2),
            # Nature
            ("Ice Crystal Macro Study",         "Nature",          "https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=500&q=80", 3,5,2),
            ("Desert Dunes Golden Hour",        "Nature",          "https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=500&q=80", 1,4,2),
            # Food
            ("Sourdough Scoring Patterns",      "Food",            "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=500&q=80", 3,4,5),
            ("Japanese Breakfast Bird's Eye",   "Food",            "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500&q=80", 2,4,5),
            # Fashion
            ("Textural Linen Layering",         "Fashion",         "https://images.unsplash.com/photo-1543966888-7c1dc482a810?w=500&q=80",   2,4,3),
            ("Monochrome Editorial in Fog",     "Fashion",         "https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=500&q=80", 3,5,2),
            # Travel
            ("Fjord Ferry Crossing at Dusk",    "Travel",          "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=500&q=80", 1,5,3),
            ("Narrow Streets of Old Lisbon",    "Travel",          "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&q=80",   1,4,3),
            ("Salt Flats Mirror at Sunset",     "Travel",          "https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5?w=500&q=80", 1,5,2),
            # Tech
            ("Circuit Board Abstraction",       "Tech",            "https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&q=80", 4,4,4),
            ("LED Neon Sign Workshop",          "Tech",            "https://images.unsplash.com/photo-1461695008884-244cb4543d74?w=500&q=80", 4,5,3),
            # NEW CATEGORIES
            # Anime
            ("Cyberpunk Anime Cityscape",       "Anime",           "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=500&q=80", 2,5,3),
            ("Aesthetic Anime Room Setup",      "Anime",           "https://images.unsplash.com/photo-1560169897-fc0cdbdfa4d5?w=500&q=80",   1,5,3),
            # Cars
            ("Supercar Street Photography",     "Cars",            "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=500&q=80", 2,5,4),
            ("Classic Car Garage Aesthetic",    "Cars",            "https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=500&q=80", 2,4,3),
            # Bikes
            ("Sports Bike at Sunset",           "Bikes",           "https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=500&q=80",   2,5,3),
            ("Cafe Racer Custom Build",         "Bikes",           "https://images.unsplash.com/photo-1609630875171-b1321377ee65?w=500&q=80", 4,5,3),
            # Scenery
            ("Mountain Lake Reflection",        "Scenery",         "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=500&q=80", 1,5,2),
            ("Aurora Borealis Night Sky",       "Scenery",         "https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=500&q=80", 1,5,2),
            # Gaming
            ("Minimal Gaming Desk Setup",       "Gaming",          "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=500&q=80",   3,5,4),
            ("Retro Console Collection",        "Gaming",          "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=500&q=80",   2,4,4),
            # Ladies Accessories
            ("Colorful Glass Bangles",          "Ladies Accessories","https://images.unsplash.com/photo-1611085583191-a3b181a88401?w=500&q=80",1,5,4),
            ("Gold Hoop Earrings",              "Ladies Accessories","https://images.unsplash.com/photo-1630019852942-f89202989a59?w=500&q=80",1,5,4),
            ("Scrunchie Hair Collection",       "Ladies Accessories","https://images.unsplash.com/photo-1594938298603-c8148c4b4f5b?w=500&q=80",1,4,4),
            ("Layered Gold Necklaces",          "Ladies Accessories","https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=500&q=80",1,5,4),
            ("Stacked Bracelets Stack",         "Ladies Accessories","https://images.unsplash.com/photo-1573408301185-9519f94c9a17?w=500&q=80",1,5,4),
        ]

        for title, cat, img, d, cr, u in demo:
            conn.execute(
                """INSERT INTO ideas
                   (user_id,title,category,image_url,difficulty,creativity,usefulness,source)
                   VALUES (?,?,?,?,?,?,?,'discovery')""",
                (admin_id, title, cat, img, d, cr, u)
            )
        conn.commit()
        print(f"✅ Seeded {len(demo)} demo ideas across {len(set(x[1] for x in demo))} categories")
    finally:
        conn.close()

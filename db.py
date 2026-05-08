import sqlite3
import threading
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "fnb58.db"


class SessionDB:
    def __init__(self):
        DB_PATH.parent.mkdir(exist_ok=True)
        self._conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init()
        self._migrate()

    def _init(self):
        with self._lock:
            self._conn.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                PRAGMA foreign_keys=ON;

                CREATE TABLE IF NOT EXISTS sessions (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at   TEXT NOT NULL,
                    ended_at     TEXT,
                    samples      INTEGER NOT NULL DEFAULT 0,
                    energy_Wh    REAL,
                    capacity_mAh REAL,
                    v_max        REAL,
                    a_max        REAL,
                    w_max        REAL
                );

                CREATE TABLE IF NOT EXISTS readings (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    ts           TEXT    NOT NULL,
                    voltage      REAL    NOT NULL,
                    current      REAL    NOT NULL,
                    power        REAL    NOT NULL,
                    energy_Wh    REAL    NOT NULL,
                    capacity_mAh REAL    NOT NULL,
                    temperature  REAL    NOT NULL,
                    dp           REAL    NOT NULL,
                    dn           REAL    NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_readings_session ON readings(session_id);

                UPDATE sessions SET ended_at = datetime('now')
                WHERE ended_at IS NULL;
            """)
            self._conn.commit()

    def _migrate(self):
        """Add columns introduced after the initial schema."""
        new_cols = [
            "ALTER TABLE sessions ADD COLUMN name TEXT",
            "ALTER TABLE sessions ADD COLUMN w_avg REAL",
        ]
        with self._lock:
            for sql in new_cols:
                try:
                    self._conn.execute(sql)
                except sqlite3.OperationalError:
                    pass  # column already exists
            self._conn.commit()

    def open_session(self):
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO sessions (started_at) VALUES (?)",
                (datetime.now().isoformat(),)
            )
            self._conn.commit()
            return cur.lastrowid

    def close_session(self, session_id, v_max, a_max, w_max):
        with self._lock:
            row = self._conn.execute(
                """SELECT COUNT(*) AS n,
                          MAX(energy_Wh)    AS wh,
                          MAX(capacity_mAh) AS mah,
                          AVG(power)        AS w_avg
                   FROM readings WHERE session_id = ?""",
                (session_id,)
            ).fetchone()

            if row["n"] == 0:
                self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            else:
                self._conn.execute("""
                    UPDATE sessions
                    SET ended_at=?, samples=?, energy_Wh=?, capacity_mAh=?,
                        v_max=?, a_max=?, w_max=?, w_avg=?
                    WHERE id = ?
                """, (datetime.now().isoformat(), row["n"],
                      row["wh"], row["mah"],
                      v_max, a_max, w_max, row["w_avg"],
                      session_id))
            self._conn.commit()

    def rename_session(self, session_id, name):
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET name=? WHERE id=?",
                (name or None, session_id)
            )
            self._conn.commit()

    def write_readings(self, session_id, batch):
        if not batch:
            return
        with self._lock:
            self._conn.executemany("""
                INSERT INTO readings
                    (session_id, ts, voltage, current, power,
                     energy_Wh, capacity_mAh, temperature, dp, dn)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [
                (session_id, r["timestamp"], r["voltage"], r["current"], r["power"],
                 r["energy_Wh"], r["capacity_mAh"], r["temperature"], r["dp"], r["dn"])
                for r in batch
            ])
            self._conn.commit()

    def get_sessions(self):
        with self._lock:
            rows = self._conn.execute("""
                SELECT id, name, started_at, ended_at, samples,
                       energy_Wh, capacity_mAh, v_max, a_max, w_max, w_avg
                FROM sessions
                ORDER BY id DESC
                LIMIT 200
            """).fetchall()
        return [dict(r) for r in rows]

    def get_readings(self, session_id, max_points=2000):
        with self._lock:
            total = self._conn.execute(
                "SELECT COUNT(*) FROM readings WHERE session_id = ?", (session_id,)
            ).fetchone()[0]

            if total == 0:
                return []

            step = max(1, total // max_points)
            rows = self._conn.execute("""
                SELECT ts, voltage, current, power,
                       energy_Wh, capacity_mAh, temperature, dp, dn
                FROM (
                    SELECT *, ROW_NUMBER() OVER (ORDER BY ts) AS rn
                    FROM readings WHERE session_id = ?
                )
                WHERE (rn - 1) % ? = 0
            """, (session_id, step)).fetchall()
        return [dict(r) for r in rows]

    def get_all_readings(self, session_id):
        """All readings without downsampling — for CSV export."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT ts, voltage, current, power,
                          energy_Wh, capacity_mAh, temperature, dp, dn
                   FROM readings WHERE session_id = ? ORDER BY ts""",
                (session_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_session(self, session_id):
        with self._lock:
            self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            self._conn.commit()

import io
import csv
import sys
import threading
from collections import deque
from urllib.parse import quote

from flask import Flask, render_template, jsonify, request, Response
from flask_socketio import SocketIO
from fnb58_reader import FNB58Reader
from db import SessionDB

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

reader = FNB58Reader()
db = SessionDB()

_connected      = False
_session_id     = None
_write_deque    = deque()
_writer_stop    = threading.Event()
_writer_thread  = None
_sess_v_max     = 0.0
_sess_a_max     = 0.0
_sess_w_max     = 0.0
_sample_counter = 0


def on_reading(r):
    global _sample_counter, _sess_v_max, _sess_a_max, _sess_w_max
    socketio.emit("reading", r)
    if _session_id is not None:
        if r["voltage"] > _sess_v_max: _sess_v_max = r["voltage"]
        if r["current"] > _sess_a_max: _sess_a_max = r["current"]
        if r["power"]   > _sess_w_max: _sess_w_max = r["power"]
        _sample_counter += 1
        if _sample_counter % 10 == 0:
            _write_deque.append(r)


def _batch_writer():
    while not _writer_stop.wait(timeout=1.0):
        _flush_to_db()
    _flush_to_db()


def _flush_to_db():
    if not _write_deque or _session_id is None:
        return
    batch = []
    while _write_deque:
        try:
            batch.append(_write_deque.popleft())
        except IndexError:
            break
    if batch:
        try:
            db.write_readings(_session_id, batch)
        except Exception as e:
            print(f"[db] {e}", file=sys.stderr)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    return jsonify({"connected": _connected})


@app.route("/api/connect", methods=["POST"])
def connect():
    global _connected, _session_id, _writer_thread, _sample_counter
    global _sess_v_max, _sess_a_max, _sess_w_max
    if _connected:
        return jsonify({"ok": True})
    try:
        reader.connect()
        reader._callbacks.clear()
        reader.register_callback(on_reading)
        reader.start()
        _session_id     = db.open_session()
        _sample_counter = 0
        _sess_v_max = _sess_a_max = _sess_w_max = 0.0
        _writer_stop.clear()
        _writer_thread = threading.Thread(target=_batch_writer, daemon=True)
        _writer_thread.start()
        _connected = True
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    global _connected, _session_id, _writer_thread
    reader.stop()
    reader.disconnect()
    sid = _session_id
    _session_id = None
    if sid:
        _writer_stop.set()
        if _writer_thread:
            _writer_thread.join(timeout=5)
        _writer_thread = None
        db.close_session(sid, _sess_v_max, _sess_a_max, _sess_w_max)
    _connected = False
    return jsonify({"ok": True})


@app.route("/api/reset", methods=["POST"])
def reset():
    reader.reset_accumulators()
    return jsonify({"ok": True})


# ── Sessions ─────────────────────────────────────────────────────

@app.route("/api/sessions")
def get_sessions():
    return jsonify(db.get_sessions())


@app.route("/api/sessions/<int:sid>/readings")
def get_readings(sid):
    return jsonify(db.get_readings(sid))


@app.route("/api/sessions/<int:sid>/csv")
def session_csv(sid):
    rows = db.get_all_readings(sid)
    if not rows:
        return "", 404

    buf = io.StringIO()
    cols = ["ts", "voltage", "current", "power",
            "energy_Wh", "capacity_mAh", "temperature", "dp", "dn"]
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)

    sessions = db.get_sessions()
    sess = next((s for s in sessions if s["id"] == sid), None)
    num  = request.args.get("num", sid)
    name = sess.get("name") if sess else None
    if name:
        filename = f"{name}_#{num}.csv".replace(" ", "_")
    else:
        filename = f"sesion_{num}.csv"

    encoded = quote(filename, safe="")
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"}
    )


@app.route("/api/sessions/<int:sid>", methods=["PATCH"])
def rename_session(sid):
    data = request.get_json(silent=True) or {}
    db.rename_session(sid, data.get("name", ""))
    return jsonify({"ok": True})


@app.route("/api/sessions/<int:sid>", methods=["DELETE"])
def delete_session(sid):
    db.delete_session(sid)
    return jsonify({"ok": True})


if __name__ == "__main__":
    print("FNB58 Monitor → http://localhost:5000")
    socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)

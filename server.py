"""Roomline: persistent collaborative chat and whiteboards."""

import base64
import hashlib
import io
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory
from PIL import Image, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).parent
app = Flask(__name__, static_folder=str(ROOT / 'static'), static_url_path='/static')
app.config.update(MAX_CONTENT_LENGTH=10 * 1024 * 1024, DATABASE=os.environ.get('ROOMLINE_DB', str(ROOT / 'roomline.db')))
write_lock = threading.RLock()
presence_lock = threading.RLock()
connections = {}
room_cursors = {}


def now():
    return int(time.time())


@contextmanager
def connect():
    connection = sqlite3.connect(app.config['DATABASE'], timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys=ON')
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize():
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
            password TEXT NOT NULL, avatar BLOB, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT REFERENCES users(id),
            invite TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, activity INTEGER NOT NULL,
            dissolved INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS members (
            room_id TEXT REFERENCES rooms(id), user_id TEXT REFERENCES users(id),
            joined INTEGER NOT NULL, spoken INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(room_id,user_id));
        CREATE TABLE IF NOT EXISTS bans (
            room_id TEXT REFERENCES rooms(id), user_id TEXT REFERENCES users(id),
            PRIMARY KEY(room_id,user_id));
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT REFERENCES rooms(id),
            user_id TEXT REFERENCES users(id), content TEXT NOT NULL, created INTEGER NOT NULL,
            system INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS strokes (
            id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id), user_id TEXT REFERENCES users(id),
            data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
            sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT REFERENCES rooms(id),
            type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), room_id TEXT,
            room_name TEXT NOT NULL, name TEXT NOT NULL, image BLOB NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id),
            room_id TEXT REFERENCES rooms(id), content TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS room_events ON events(room_id,id);
        CREATE INDEX IF NOT EXISTS room_messages ON messages(room_id,id);
        ''')


@contextmanager
def transaction():
    # Membership checks and mutations share a transaction with event creation.
    with write_lock, connect() as db:
        db.execute('BEGIN IMMEDIATE')
        yield db


@app.before_request
def authenticate():
    g.user = None
    token = session_token()
    if token:
        with connect() as db:
            g.user = db.execute('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id '
                                'WHERE token=? AND expires>?', (hashlib.sha256(token.encode()).hexdigest(), now())).fetchone()
    if request.path.startswith('/api/') and request.path not in ('/api/login', '/api/register'):
        if g.user is None:
            abort(401, 'Please sign in to continue.')
    if request.method != 'GET' and request.path.startswith('/api/'):
        origin = request.headers.get('Origin')
        if origin and origin != request.host_url.rstrip('/'):
            abort(403, 'Cross-origin requests are not permitted.')


@app.after_request
def security_headers(response):
    if request.path.endswith('.js'):
        response.headers['Content-Type'] = 'application/javascript; charset=utf-8'
    elif request.path.endswith('.css'):
        response.headers['Content-Type'] = 'text/css; charset=utf-8'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    return response


@app.errorhandler(Exception)
def errors(error):
    from werkzeug.exceptions import HTTPException
    if isinstance(error, HTTPException):
        return jsonify(error=error.description), error.code
    app.logger.exception('Request failed')
    return jsonify(error='The operation could not be completed. Please try again.'), 500


def payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, 'Expected a JSON object.')
    return data


def text(data, key, limit, default=''):
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        abort(400, f'{key.capitalize()} must contain 1 to {limit} characters.')
    return value.strip()


def public_user(user):
    return dict(id=user['id'], nickname=user['nickname'], username=user['username'], avatar=f"/avatar/{user['id']}")


def room_access(db, room_id, owner=False):
    room = db.execute('SELECT * FROM rooms WHERE id=? AND dissolved=0', (room_id,)).fetchone()
    if room is None:
        abort(404, 'This room has been dissolved or does not exist.')
    if not db.execute('SELECT 1 FROM members WHERE room_id=? AND user_id=?', (room_id, g.user['id'])).fetchone():
        abort(403, 'You are no longer a member of this room.')
    if owner and room['owner'] != g.user['id']:
        abort(403, 'Only the room owner can do that.')
    return room


def emit(db, room_id, kind, data):
    cursor = db.execute('INSERT INTO events(room_id,type,data) VALUES(?,?,?)', (room_id, kind, json.dumps(data)))
    return cursor.lastrowid


def system_message(db, room_id, content):
    db.execute('INSERT INTO messages(room_id,content,created,system) VALUES(?,?,?,1)', (room_id, content, now()))
    emit(db, room_id, 'refresh', {})


def announce_owner(db, room, user_id, automatic=False):
    nickname = db.execute('SELECT nickname FROM users WHERE id=?', (user_id,)).fetchone()[0]
    content = f"{nickname} was {'randomly selected as' if automatic else 'appointed'} the new owner of {room['name']}."
    system_message(db, room['id'], content)
    db.execute('UPDATE notifications SET seen=1 WHERE room_id=?', (room['id'],))
    db.execute('INSERT INTO notifications(user_id,room_id,content) VALUES(?,?,?)', (user_id, room['id'], content))
    emit(db, room['id'], 'owner_changed', dict(user_id=user_id, content=content))


@app.get('/api/notifications')
def notifications():
    with connect() as db:
        rows = db.execute('SELECT notifications.* FROM notifications JOIN rooms ON rooms.id=notifications.room_id '
                          'WHERE user_id=? AND seen=0 AND dissolved=0 AND rooms.owner=? ORDER BY notifications.id', (g.user['id'], g.user['id'])).fetchall()
        return jsonify(notifications=[dict(row) for row in rows])


@app.post('/api/notifications/<int:notification_id>/read')
def read_notification(notification_id):
    with transaction() as db:
        db.execute('UPDATE notifications SET seen=1 WHERE id=? AND user_id=?', (notification_id, g.user['id']))
    return jsonify(ok=True)


def session_cookie_name():
    selector = request.headers.get('X-Roomline-Session') or request.args.get('session_id')
    if selector:
        if not re.fullmatch('[0-9a-f]{24}', selector):
            abort(401, 'Please sign in again.')
        return 'roomline_session_' + selector
    return 'roomline_session'


def session_token():
    return request.cookies.get(session_cookie_name(), '')


def session_response(db, user):
    token = secrets.token_urlsafe(32)
    selector = secrets.token_hex(12)
    db.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), user['id'], now()+30*86400))
    response = jsonify(user=public_user(user), session_id=selector)
    response.set_cookie('roomline_session_' + selector, token, httponly=True, samesite='Lax', secure=request.is_secure, max_age=30*86400)
    response.set_cookie('roomline_session', token, httponly=True, samesite='Lax', secure=request.is_secure, max_age=30*86400)
    return response


@app.post('/api/register')
def register():
    data = payload()
    username = text(data, 'username', 32).lower()
    nickname = text(data, 'nickname', 40)
    password = text(data, 'password', 128)
    if not re.fullmatch('[a-z0-9_.-]{3,32}', username) or len(password) < 8:
        abort(400, 'Use a 3–32 character username (letters, numbers, dot, dash, underscore) and a password of at least 8 characters.')
    with transaction() as db:
        if db.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
            abort(409, 'This username is already taken.')
        user_id = secrets.token_hex(12)
        db.execute('INSERT INTO users(id,username,nickname,password,created) VALUES(?,?,?,?,?)',
                   (user_id, username, nickname, generate_password_hash(password), now()))
        return session_response(db, db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone())


@app.post('/api/login')
def login():
    data = payload()
    username = text(data, 'username', 32).lower()
    password = text(data, 'password', 128)
    with transaction() as db:
        user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if user is None or not check_password_hash(user['password'], password):
            abort(401, 'The username or password is incorrect.')
        return session_response(db, user)


@app.post('/api/logout')
def logout():
    token = session_token()
    with transaction() as db:
        db.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(token.encode()).hexdigest(),))
    response = jsonify(ok=True)
    response.delete_cookie(session_cookie_name())
    return response


@app.get('/api/me')
def me():
    return jsonify(user=public_user(g.user))


def image_bytes(encoded):
    if not isinstance(encoded, str) or not encoded.startswith('data:image/'):
        abort(400, 'Choose an image file.')
    try:
        raw = base64.b64decode(encoded.split(',', 1)[1], validate=True)
        if len(raw) > 6*1024*1024:
            abort(400, 'Choose an image smaller than 6 MB.')
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 12_000_000:
                abort(400, 'The image dimensions are too large.')
            output = io.BytesIO()
            image.convert('RGB').save(output, format='PNG')
            return output.getvalue()
    except (ValueError, IndexError, UnidentifiedImageError, OSError):
        abort(400, 'The image could not be read.')


@app.post('/api/profile')
def profile():
    data = payload()
    nickname = text(data, 'nickname', 40)
    avatar = image_bytes(data['avatar']) if data.get('avatar') else None
    with transaction() as db:
        if data.get('password'):
            password = text(data, 'password', 128)
            if len(password) < 8 or not check_password_hash(g.user['password'], str(data.get('current_password', ''))):
                abort(400, 'Check your current password and use at least 8 characters for the new password.')
            db.execute('UPDATE users SET password=? WHERE id=?', (generate_password_hash(password), g.user['id']))
            token_hash = hashlib.sha256(session_token().encode()).hexdigest()
            db.execute('DELETE FROM sessions WHERE user_id=? AND token<>?', (g.user['id'], token_hash))
        db.execute('UPDATE users SET nickname=? WHERE id=?', (nickname, g.user['id']))
        if avatar:
            db.execute('UPDATE users SET avatar=? WHERE id=?', (avatar, g.user['id']))
        rooms = db.execute('SELECT room_id FROM members WHERE user_id=?', (g.user['id'],)).fetchall()
        for room in rooms:
            emit(db, room['room_id'], 'members', {})
        return jsonify(user=public_user(db.execute('SELECT * FROM users WHERE id=?', (g.user['id'],)).fetchone()))


@app.get('/avatar/<user_id>')
def avatar(user_id):
    if g.user is None:
        abort(401)
    with connect() as db:
        user = db.execute('SELECT avatar FROM users WHERE id=?', (user_id,)).fetchone()
    if user is None:
        abort(404)
    if user['avatar']:
        return Response(user['avatar'], mimetype='image/png')
    seed = int(hashlib.sha256(user_id.encode()).hexdigest()[:8], 16)
    colors = [('#dce7fc', '#a9bbdc'), ('#e9dff5', '#c3afd7'),
              ('#f9e0d4', '#d6b5a4'), ('#d9eee3', '#aacdbc'),
              ('#f3eacb', '#cfc296')]
    background, figure = colors[seed % len(colors)]
    # A filled head and shoulders use a slightly deeper background tone.
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">'
        '<defs><clipPath id="avatar-circle"><circle cx="40" cy="40" r="38"/></clipPath></defs>'
        f'<circle cx="40" cy="40" r="40" fill="{background}"/>'
        f'<g fill="{figure}" clip-path="url(#avatar-circle)">'
        '<circle cx="40" cy="27" r="13"/>'
        '<path d="M10 80 L14 67 C20 53 29 47 40 47 C51 47 60 53 66 67 L70 80 Z"/>'
        '</g></svg>'
    )
    return Response(svg, mimetype='image/svg+xml')


def online_users(room_id):
    with presence_lock:
        return {user for (room, user), streams in connections.items() if room == room_id and streams}


@app.get('/api/rooms')
def rooms():
    with connect() as db:
        rows = db.execute('SELECT rooms.*,(SELECT COUNT(*) FROM members WHERE room_id=rooms.id) member_count '
                          'FROM rooms JOIN members ON rooms.id=members.room_id '
                          'WHERE members.user_id=? AND dissolved=0 ORDER BY activity DESC', (g.user['id'],)).fetchall()
        result = [dict(row) for row in rows]
    for row in result:
        row['online'] = len(online_users(row['id']))
    return jsonify(rooms=result)


@app.post('/api/rooms')
def create_room():
    name = text(payload(), 'name', 70)
    room_id = secrets.token_hex(6)
    with transaction() as db:
        db.execute('INSERT INTO rooms(id,name,owner,invite,created,activity) VALUES(?,?,?,?,?,?)',
                   (room_id, name, g.user['id'], secrets.token_urlsafe(24), now(), now()))
        db.execute('INSERT INTO members(room_id,user_id,joined) VALUES(?,?,?)', (room_id, g.user['id'], now()))
        system_message(db, room_id, f"{g.user['nickname']} created the room.")
    return jsonify(id=room_id)


@app.post('/api/join')
def join():
    invite = text(payload(), 'invite', 500).split('invite=')[-1].split('&')[0]
    with transaction() as db:
        room = db.execute('SELECT * FROM rooms WHERE invite=? AND dissolved=0', (invite,)).fetchone()
        if room is None:
            abort(404, 'This invitation has expired or the room has been dissolved.')
        if db.execute('SELECT 1 FROM bans WHERE room_id=? AND user_id=?', (room['id'], g.user['id'])).fetchone():
            abort(403, 'You were removed from this room. Ask the owner to restore your access.')
        existing = db.execute('SELECT 1 FROM members WHERE room_id=? AND user_id=?', (room['id'], g.user['id'])).fetchone()
        if not existing:
            db.execute('INSERT INTO members(room_id,user_id,joined) VALUES(?,?,?)', (room['id'], g.user['id'], now()))
            system_message(db, room['id'], f"{g.user['nickname']} joined the room.")
    return jsonify(id=room['id'])


def member_list(db, room_id):
    live = online_users(room_id)
    rows = db.execute('SELECT users.*,members.spoken,members.joined FROM members JOIN users '
                      'ON members.user_id=users.id WHERE room_id=? ORDER BY spoken DESC, joined, users.id', (room_id,)).fetchall()
    return [dict(**public_user(row), online=row['id'] in live, spoken=row['spoken']) for row in rows]


@app.get('/api/rooms/<room_id>')
def room_state(room_id):
    with write_lock, connect() as db:
        room = room_access(db, room_id)
        messages = db.execute('SELECT * FROM (SELECT messages.*,users.nickname FROM messages LEFT JOIN users '
                              'ON messages.user_id=users.id WHERE room_id=? ORDER BY messages.id DESC LIMIT 300) ORDER BY id', (room_id,)).fetchall()
        strokes = db.execute('SELECT id,user_id,data,sequence FROM strokes WHERE room_id=? AND deleted=0 ORDER BY sequence', (room_id,)).fetchall()
        cursor = db.execute('SELECT COALESCE(MAX(id),0) FROM events WHERE room_id=?', (room_id,)).fetchone()[0]
        return jsonify(room=dict(room), members=member_list(db, room_id), messages=[dict(row) for row in messages],
                       strokes=[dict(id=row['id'], user_id=row['user_id'], sequence=row['sequence'], **json.loads(row['data'])) for row in strokes], cursor=cursor)


@app.post('/api/rooms/<room_id>/message')
def message(room_id):
    content = text(payload(), 'content', 4000)
    with transaction() as db:
        room_access(db, room_id)
        cursor = db.execute('INSERT INTO messages(room_id,user_id,content,created) VALUES(?,?,?,?)', (room_id, g.user['id'], content, now()))
        db.execute('UPDATE members SET spoken=? WHERE room_id=? AND user_id=?', (cursor.lastrowid, room_id, g.user['id']))
        db.execute('UPDATE rooms SET activity=? WHERE id=?', (now(), room_id))
        emit(db, room_id, 'message', dict(id=cursor.lastrowid, user_id=g.user['id'], nickname=g.user['nickname'], content=content, created=now(), system=0))
    return jsonify(ok=True)


def drawing_payload(data):
    stroke_id = text(data, 'id', 80)
    points = data.get('points')
    if data.get('tool') not in ('pen', 'eraser', 'line', 'rectangle') or not re.fullmatch('#[0-9a-fA-F]{6}', str(data.get('color'))):
        abort(400, 'Invalid drawing tool or color.')
    if not isinstance(data.get('width'), (float, int)) or not 1 <= data['width'] <= 40:
        abort(400, 'Invalid stroke width.')
    if not isinstance(points, list) or not 1 <= len(points) <= 12000:
        abort(400, 'Invalid drawing points.')
    for point in points:
        if not isinstance(point, list) or len(point) != 2 or not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in point):
            abort(400, 'Drawing coordinates must be between zero and one.')
    return stroke_id, {key: data[key] for key in ('tool', 'color', 'width', 'points')}


@app.post('/api/rooms/<room_id>/preview')
def preview_stroke(room_id):
    stroke_id, clean = drawing_payload(payload())
    with transaction() as db:
        room_access(db, room_id)
        # Finished strokes win over preview requests that arrive out of order.
        if not db.execute('SELECT 1 FROM strokes WHERE id=?', (stroke_id,)).fetchone():
            emit(db, room_id, 'preview', dict(id=stroke_id, user_id=g.user['id'], **clean))
    return jsonify(ok=True)


@app.post('/api/rooms/<room_id>/cursor')
def update_cursor(room_id):
    data = payload()
    visible = data.get('visible')
    if not isinstance(visible, bool):
        abort(400, 'Cursor visibility must be a boolean.')
    if visible and not all(isinstance(data.get(key), (float, int)) and 0 <= data[key] <= 1 for key in ('x', 'y')):
        abort(400, 'Cursor coordinates must be between zero and one.')
    with write_lock, connect() as db:
        room_access(db, room_id)
        with presence_lock:
            key = (room_id, g.user['id'])
            if visible:
                room_cursors[key] = dict(user_id=g.user['id'], username=g.user['username'],
                                         x=data['x'], y=data['y'], expires=time.monotonic()+8)
            else:
                room_cursors.pop(key, None)
    return jsonify(ok=True)


def cursor_snapshot(room_id):
    with presence_lock:
        expired = [key for key, value in room_cursors.items() if value['expires'] <= time.monotonic()]
        for key in expired:
            room_cursors.pop(key, None)
        return [{key: value for key, value in cursor.items() if key != 'expires'}
                for (room, user_id), cursor in room_cursors.items()
                if room == room_id and connections.get((room, user_id))]


@app.post('/api/rooms/<room_id>/stroke')
def stroke(room_id):
    stroke_id, clean = drawing_payload(payload())
    with transaction() as db:
        room_access(db, room_id)
        existing = db.execute('SELECT * FROM strokes WHERE id=?', (stroke_id,)).fetchone()
        if existing:
            if existing['user_id'] == g.user['id'] and existing['room_id'] == room_id and json.loads(existing['data']) == clean:
                return jsonify(ok=True)
            abort(409, 'A drawing with this ID already exists.')
        sequence = emit(db, room_id, 'stroke', dict(id=stroke_id, user_id=g.user['id'], **clean))
        db.execute('INSERT INTO strokes(id,room_id,user_id,data,sequence) VALUES(?,?,?,?,?)', (stroke_id, room_id, g.user['id'], json.dumps(clean), sequence))
        db.execute('UPDATE rooms SET activity=? WHERE id=?', (now(), room_id))
    return jsonify(ok=True)


@app.post('/api/rooms/<room_id>/undo')
def undo(room_id):
    with transaction() as db:
        room_access(db, room_id)
        row = db.execute('SELECT id FROM strokes WHERE room_id=? AND user_id=? AND deleted=0 ORDER BY sequence DESC LIMIT 1', (room_id, g.user['id'])).fetchone()
        if row:
            db.execute('UPDATE strokes SET deleted=1 WHERE id=?', (row['id'],))
            emit(db, room_id, 'undo', dict(id=row['id']))
    return jsonify(ok=True)


@app.post('/api/rooms/<room_id>/clear')
def clear_board(room_id):
    with transaction() as db:
        room_access(db, room_id, owner=True)
        db.execute('UPDATE strokes SET deleted=1 WHERE room_id=?', (room_id,))
        emit(db, room_id, 'clear', {})
    return jsonify(ok=True)


@app.post('/api/rooms/<room_id>/manage')
def manage(room_id):
    data = payload()
    action = data.get('action')
    target = data.get('target')
    with transaction() as db:
        room = room_access(db, room_id, owner=action != 'leave')
        if action == 'dissolve':
            db.execute('UPDATE rooms SET dissolved=1 WHERE id=?', (room_id,))
            emit(db, room_id, 'dissolved', {})
        elif action == 'restore':
            db.execute('DELETE FROM bans WHERE room_id=? AND user_id=?', (room_id, target))
            emit(db, room_id, 'members', {})
        elif action in ('transfer', 'kick', 'leave'):
            if action == 'leave':
                target = g.user['id']
            member = db.execute('SELECT users.* FROM members JOIN users ON users.id=members.user_id WHERE room_id=? AND user_id=?', (room_id, target)).fetchone()
            if member is None:
                abort(400, 'Select a current room member.')
            if action in ('transfer', 'kick') and target == room['owner']:
                abort(400, 'Choose a different member.')
            if action == 'transfer':
                db.execute('UPDATE rooms SET owner=? WHERE id=?', (target, room_id))
                announce_owner(db, room, target)
            else:
                remaining = [row[0] for row in db.execute('SELECT user_id FROM members WHERE room_id=? AND user_id<>?', (room_id, target))]
                if target == room['owner']:
                    successor = data.get('successor')
                    if successor and successor not in remaining:
                        abort(400, 'The next owner must be a remaining member.')
                    next_owner = successor or (random.choice(remaining) if remaining else None)
                    db.execute('UPDATE rooms SET owner=?, dissolved=? WHERE id=?', (next_owner, 0 if remaining else 1, room_id))
                    if next_owner:
                        announce_owner(db, room, next_owner, automatic=not bool(successor))
                db.execute('DELETE FROM members WHERE room_id=? AND user_id=?', (room_id, target))
                if action == 'kick':
                    db.execute('INSERT OR IGNORE INTO bans VALUES(?,?)', (room_id, target))
                system_message(db, room_id, f"{member['nickname']} {'was removed from' if action == 'kick' else 'left'} the room.")
                emit(db, room_id, 'removed', dict(user_id=target))
        else:
            abort(400, 'Unknown management action.')
    return jsonify(ok=True)


@app.get('/api/rooms/<room_id>/bans')
def banned_members(room_id):
    with connect() as db:
        room_access(db, room_id, owner=True)
        rows = db.execute('SELECT users.* FROM bans JOIN users ON users.id=bans.user_id WHERE room_id=?', (room_id,)).fetchall()
        return jsonify(members=[public_user(row) for row in rows])


@app.get('/api/rooms/<room_id>/events')
def stream(room_id):
    with connect() as db:
        room_access(db, room_id)
    user_id = g.user['id']
    nickname = g.user['nickname']
    token_hash = hashlib.sha256(session_token().encode()).hexdigest()
    room_key = (room_id, user_id)
    connection_id = secrets.token_hex(8)
    try:
        cursor = int(request.headers.get('Last-Event-ID') or request.args.get('after', '0'))
    except ValueError:
        abort(400, 'Invalid event cursor.')

    def events():
        nonlocal cursor
        previous_cursors = None
        with transaction() as db:
            with presence_lock:
                fresh = not connections.get(room_key)
                connections.setdefault(room_key, set()).add(connection_id)
            if fresh:
                system_message(db, room_id, f'{nickname} is online.')
        try:
            while True:
                with connect() as db:
                    access = db.execute('SELECT 1 FROM members JOIN rooms ON rooms.id=members.room_id WHERE room_id=? AND user_id=? AND dissolved=0', room_key).fetchone()
                    session = db.execute('SELECT 1 FROM sessions WHERE token=? AND expires>?', (token_hash, now())).fetchone()
                    batch = db.execute('SELECT * FROM events WHERE room_id=? AND id>? ORDER BY id LIMIT 100', (room_id, cursor)).fetchall() if access and session else []
                if not access or not session:
                    yield 'event: revoked\ndata: {}\n\n'
                    break
                for event in batch:
                    cursor = event['id']
                    yield f"id: {cursor}\nevent: {event['type']}\ndata: {event['data']}\n\n"
                cursors = json.dumps(cursor_snapshot(room_id), sort_keys=True)
                if cursors != previous_cursors:
                    previous_cursors = cursors
                    yield f'event: cursors\ndata: {cursors}\n\n'
                if not batch:
                    yield ': heartbeat\n\n'
                    time.sleep(0.1)
        finally:
            with transaction() as db:
                with presence_lock:
                    connections.get(room_key, set()).discard(connection_id)
                    offline = not connections.get(room_key)
                    if offline:
                        connections.pop(room_key, None)
                        room_cursors.pop(room_key, None)
                if offline:
                    emit(db, room_id, 'members', {})
    return Response(events(), mimetype='text/event-stream', headers={'X-Accel-Buffering': 'no'})


@app.get('/api/snapshots')
def snapshots():
    with connect() as db:
        rows = db.execute('SELECT id,name,room_id,room_name,created FROM snapshots WHERE user_id=? ORDER BY created DESC,id', (g.user['id'],)).fetchall()
    return jsonify(snapshots=[dict(row) for row in rows])


@app.post('/api/snapshots')
def save_snapshot():
    data = payload()
    name = text(data, 'name', 100)
    image = image_bytes(data.get('image'))
    snapshot_id = secrets.token_hex(12)
    with transaction() as db:
        room = room_access(db, data.get('room_id'))
        db.execute('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)', (snapshot_id, g.user['id'], room['id'], room['name'], name, image, now()))
    return jsonify(id=snapshot_id)


@app.get('/api/snapshots/<snapshot_id>/image')
def snapshot_image(snapshot_id):
    with connect() as db:
        row = db.execute('SELECT image FROM snapshots WHERE id=? AND user_id=?', (snapshot_id, g.user['id'])).fetchone()
    if row is None:
        abort(404)
    return Response(row['image'], mimetype='image/png')


@app.route('/api/snapshots/<snapshot_id>', methods=['PATCH', 'DELETE'])
def modify_snapshot(snapshot_id):
    with transaction() as db:
        if not db.execute('SELECT 1 FROM snapshots WHERE id=? AND user_id=?', (snapshot_id, g.user['id'])).fetchone():
            abort(404)
        if request.method == 'DELETE':
            db.execute('DELETE FROM snapshots WHERE id=?', (snapshot_id,))
        else:
            db.execute('UPDATE snapshots SET name=? WHERE id=?', (text(payload(), 'name', 100), snapshot_id))
    return jsonify(ok=True)


@app.get('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


if __name__ == '__main__':
    initialize()
    host = os.environ.get('ROOMLINE_HOST', '127.0.0.1')
    port = int(os.environ.get('ROOMLINE_PORT', '8765'))
    app.run(host=host, port=port, threaded=True, debug=False)

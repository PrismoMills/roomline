# Roomline

A local collaborative whiteboard and chat application with persistent accounts, rooms, and personal snapshots.

## Start

Requires Python 3.10 or later.

```sh
python -m pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:8765 and create an account. On Windows, you can also double-click `start.bat` after installing the dependencies.

Separate tabs in the same browser can also sign in as different users. Each tab stores a session selector in sessionStorage and uses its own HttpOnly session cookie. Chat, drawing requests, image loading, and live events all use that tab's selector. A fresh tab opens the sign-in screen, while refreshing an existing tab keeps its selected account.

For trusted LAN testing, set `ROOMLINE_HOST=0.0.0.0` before starting. Other computers must open the host computer's LAN address on port 8765. Copy an invitation from that address so it works on other devices. The host firewall must allow incoming traffic. Use HTTPS and a production WSGI server before internet deployment. The included server is intended for local demonstrations.

`ROOMLINE_DB` overrides the database path and `ROOMLINE_PORT` overrides the port. The default SQLite database is created beside `server.py`.

## Workspace

- Joined rooms persist across sessions. Closing the page keeps your membership.
- Personal snapshots show as a grid with preview, download, rename, and delete controls.
- The profile page supports nickname, avatar, and password changes.
- Invitation links continue after signing in or registering.

## Collaboration

- The whiteboard and chat share one room. A fixed four-avatar strip sits above chat, followed by an overflow member list and an invitation button.
- Members sort by their most recent message. Online members have colored avatars and green status indicators. Offline members appear gray. A room connection marks presence, and a member's arrival adds a quiet system message.
- Your messages appear on the right; other members' messages appear on the left. Default avatars are filled head-and-shoulder silhouettes in a slightly deeper shade than their circular backgrounds.
- Whiteboard cursors are small colored circles with account usernames beside them. Positions are shared with current room participants and removed on exit or disconnect. Cursors are excluded from saved snapshots.
- Tools include pen, eraser, line, rectangle, stroke width, and colors. Undo removes the requesting user's latest drawing. Only the owner can clear the shared canvas.
- Snapshots capture the visible canvas at save time and remain in the user's gallery after leaving or room dissolution.
- The creator owns the room. Ownership persists when offline. The owner can transfer control, remove members, restore invitation access, or dissolve the room.
- A departing owner can name a successor. Without a selection, a remaining member is chosen randomly, including offline members. The last member's permanent departure closes the room.
- Ownership changes add a room announcement and a notification for the successor. An offline successor receives the notification when they next open the workspace or room.

## Implementation

Flask serves the browser UI and JSON endpoints. SQLite transactions coordinate authorization, mutations, and a durable room event log. Server-Sent Events deliver room changes; client operations use HTTP POST. A reconnect resumes after the last received event. Incoming strokes have stable IDs, normalized coordinates, and server ordering. Temporary drawing previews are transmitted during dragging; completed strokes persist and take precedence over late previews.

Passwords are hashed and sessions use HttpOnly, SameSite cookies selected independently by each tab. Membership and owner permissions are checked on the server. Removed members cannot reuse an invitation until their access is restored. Personal image routes check ownership.

Messages currently display the latest 300 entries per room. Snapshots and drawings are durable. This version targets small study or project groups. It does not include password recovery, email delivery, or distributed multi-server presence.

## Verification

Run the backend integration tests from this directory:

```sh
python -B -m unittest -v test_server
```

The seven tests cover room permissions and ownership, persistence, private snapshots, account isolation across shared browser cookies, successor notifications, default avatars, and cursor validation.

The optional `test_browser.cjs` checks two tabs sharing one browser context, invitations, messaging, avatar ordering, drawing and cursor synchronization, reloading, snapshots, removal, and desktop/mobile layouts. Install Playwright and its Chromium browser, start the app with a separate test database, then run:

```sh
npm install --no-save playwright
npx playwright install chromium
node test_browser.cjs
```

`ROOMLINE_TEST_URL` can override the browser test's default base URL. Use a disposable database for browser tests because they create sample accounts, rooms, messages, and snapshots.

## Source package

The source ZIP contains the application, static assets, dependency list, launcher, documentation, and tests. Install the dependencies on the destination computer and start the server there. A fresh database is created on first startup. The package is a Python source distribution.

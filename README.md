# Roomline

**A collaborative whiteboard and chat workspace built with Flask, SQLite and JavaScript.**

Roomline lets small teams draw, discuss ideas and save whiteboard snapshots in one browser workspace. Members can return to rooms across sessions, follow each other's labeled cursors and continue a shared conversation. Room owners manage membership and hand over control when they leave.

## What you can do

- Create a room or join through an invitation link, including after signing in or registering.
- Draw with a pen, eraser, lines and rectangles, and choose stroke colors and widths.
- See other members' cursor positions with their account IDs beside them.
- Chat beside the whiteboard, with your messages on the right and other members' messages on the left.
- View online and offline members, open the full member list and invite someone from the avatar strip.
- Save whiteboard snapshots to a personal gallery, then enlarge, rename, download or delete them.
- Update your display name, avatar and password from personal settings.
- Sign in as different users in separate tabs within the same browser.

## How collaboration works

The server saves chat messages and completed drawings in SQLite and sends room updates through Server-Sent Events. Drawing operations have unique IDs and a server-defined order. Temporary previews appear during drawing, while completed strokes are retained for members who return later. Undo removes your latest drawing; the owner can clear the shared board.

Cursor positions are shared separately from whiteboard content. They disappear when a member leaves the canvas or disconnects, and are excluded from saved snapshots.

The room creator becomes its owner. Going offline preserves ownership. When an owner permanently leaves, they can select a successor or let the server randomly choose a remaining member, including an offline member. The room receives an announcement and the successor receives a notification. An offline successor sees the notification when they next open the workspace or room.

Owners can remove members, restore their invitation access, transfer ownership or dissolve a room. Personal snapshots remain available after leaving or room dissolution. The last member's permanent departure closes the room.

## Run locally

Requirements are Python 3.10 or later and a web browser.

```sh
python -m pip install -r requirements.txt
python server.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765), create an account and choose **Create room**. On Windows, you can also double-click `start.bat` after installing dependencies.

A fresh tab opens the sign-in page. Refreshing an existing tab keeps that tab's account. The application creates `roomline.db` beside `server.py` for accounts, rooms, messages, drawings and snapshots.

### Connect over a local network

Start the server from PowerShell on the host computer.

```powershell
$env:ROOMLINE_HOST = "0.0.0.0"
python server.py
```

Other devices on the same network can open the host computer's LAN IP address on port 8765. For example, use `http://192.168.1.100:8765` with your host's actual address. Allow the connection through the host's firewall and copy invitations from that address. The host computer and server must remain running.

`ROOMLINE_PORT` changes the port. `ROOMLINE_DB` selects a different database file. The source repository and ZIP package exclude the local database.

## Project layout

```text
server.py          Flask API, room events, permissions and SQLite storage
static/index.html  Browser entry point
static/app.js      Workspace, chat, drawing and cursor interactions
static/style.css   Desktop and mobile layouts
start.bat          Windows launcher
test_server.py     Backend integration checks
test_browser.cjs   Shared-browser collaboration and layout checks
```

## Validation

```sh
python -B -m unittest -v test_server
```

The backend tests cover permissions, ownership changes, persistence, private snapshots, independent accounts across shared browser cookies, successor notifications, avatar output and cursor validation.

The optional browser checks use Playwright. Start the application with a disposable test database, then run:

```sh
npm install --no-save playwright
npx playwright install chromium
node test_browser.cjs
```

`ROOMLINE_TEST_URL` overrides the browser tests' base URL. These checks create sample accounts and room content and exercise invitations, messages, drawings, labeled cursors, reconnection, snapshots, member removal and responsive layouts.

## Current scope

This version supports small-group use on one computer or a trusted local network. The chat panel displays the latest 300 messages per room. Presence tracking runs in one server process. Internet deployment requires HTTPS and a production WSGI server.

Passwords are hashed, sessions use HttpOnly and SameSite cookies, and the server checks membership and ownership. Password recovery and email delivery are not implemented.

<div align="center">

<h1>Roomline</h1>
<p><strong>A shared canvas with the conversation beside it.</strong></p>
<p>Draw together, follow each other's cursors, and keep the ideas worth coming back to.</p>

<p>
<img alt="Python 3.10 or later" src="https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white">
<img alt="Flask and SQLite" src="https://img.shields.io/badge/Storage-SQLite-4479A1?logo=sqlite&logoColor=white">
<img alt="Web application" src="https://img.shields.io/badge/Platform-Web-4566E8">
</p>

<p><a href="#inside-a-room">Inside a room</a> · <a href="#your-workspace">Your workspace</a> · <a href="#get-started">Get started</a> · <a href="#bring-in-your-team">Local network</a></p>

</div>

---

A study session, a project discussion, a diagram you need to explain. Roomline gives your group a whiteboard and a chat in the same room, with saved content so you can return to the discussion later.

## Inside a room

| ✏️ Shared whiteboard | 💬 Conversation | 👥 People |
| --- | --- | --- |
| Pen, eraser, lines and rectangles, with colors and stroke widths. Undo your own latest drawing. | Messages stay beside the canvas. Yours appear on the right, everyone else's on the left. | See who's online, follow labeled cursors, and invite someone with a room link. |

The member strip shows four avatars, an overflow list when needed, and an invitation button. Recent speakers move to the front. Offline members appear gray, and arrivals add a quiet message to the conversation.

**Room owners keep things organized.** The creator can remove members, restore invitation access, transfer ownership, clear the board or dissolve the room. Going offline preserves ownership. On permanent departure, the owner can choose a successor or let Roomline select one randomly from the remaining members. The successor receives a notification, including when they next return from being offline.

## Your workspace

**Return to a room.** Joined rooms stay on your personal page until you leave them. Messages and completed drawings remain available across sessions.

**Keep a snapshot.** Save the current board to your gallery, open it at a larger size, rename it, download it or delete it. Personal snapshots survive leaving a room or room dissolution. Cursor labels are excluded from the saved image.

**Use your own identity.** Set a display name, upload an avatar and change your password. Separate tabs can sign in as different accounts in the same browser.

## Get started

You need **Python 3.10+** and a browser.

```sh
python -m pip install -r requirements.txt
python server.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765), create an account, and choose **Create room**. Send the invitation link to another member. A person following an invitation can sign in or register before joining.

On Windows, `start.bat` also starts the app after dependencies are installed.

## Bring in your team

For devices on the same local network, start the server on the host computer using this command.

```powershell
$env:ROOMLINE_HOST = "0.0.0.0"
python server.py
```

Then open the host's LAN address on port 8765, such as `http://192.168.1.100:8765`, using its actual IP. Copy invitations from that address. Allow the connection through the host firewall and keep the host running.

> `127.0.0.1` always refers to the device opening the page. Other devices need the host computer's LAN address.

<details>
<summary><strong>Under the hood & development checks</strong></summary>

Flask serves the UI and JSON API. SQLite transactions save room changes with a durable event log. Server-Sent Events deliver updates and resume after the last event on reconnect. Completed drawings use unique IDs and server ordering, while temporary previews and cursor positions let other members follow the work.

Passwords are hashed. HttpOnly, SameSite cookies and a per-tab session selector keep account identities separate. The server checks membership, owner permissions and access to personal snapshots.

| File | Responsibility |
| --- | --- |
| `server.py` | API, permissions, room events and SQLite storage |
| `static/app.js` | Workspace, messaging, drawing and cursors |
| `static/style.css` | Responsive desktop and mobile layouts |
| `test_server.py` | Backend integration checks |
| `test_browser.cjs` | Two-tab collaboration and layout checks |

The app creates `roomline.db` beside `server.py`. Set `ROOMLINE_DB` to use another database and `ROOMLINE_PORT` to change the port. Local databases are excluded from the repository and source package.

```sh
python -B -m unittest -v test_server
```

For optional browser checks, start the app with a disposable database, install Playwright and run:

```sh
npm install --no-save playwright
npx playwright install chromium
node test_browser.cjs
```

`ROOMLINE_TEST_URL` selects the browser tests' base URL. Tests create sample accounts and room content.

</details>

## A few things to know

Roomline currently targets small groups on one computer or a trusted local network. The chat panel shows the latest 300 messages, and presence tracking runs in one server process. Internet hosting requires HTTPS and a production WSGI server.

The last member's permanent departure closes the room. Password recovery and email delivery remain future work.

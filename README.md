# Roomline

**A shared whiteboard and conversation space for small teams.**

Roomline brings drawing, chat, and room members into one browser workspace. Sketch an idea while discussing it, see where others are pointing, and save a useful moment to revisit later.

Built for study groups, project discussions, and collaborative planning, Roomline keeps your rooms and their content available between sessions. Sign in, open a room, and continue where you left off.

## Work together on the same canvas

Draw freely, add lines and rectangles, switch colors, or adjust your stroke width. Changes appear on your teammates' whiteboards as you work. Each person's cursor carries their account ID, making it easy to follow a discussion across the canvas.

Undo removes your own latest drawing. Room owners can clear the shared board when the group is ready to start again.

## Keep the conversation beside the work

The whiteboard sits beside a dedicated chat panel, so sketches and messages stay in view together. Your messages appear on the right, and messages from other members appear on the left.

A compact member strip shows who's in the room. Online avatars stay in color, offline avatars turn gray, and recent speakers move to the front. Open the overflow list to see everyone, or use the **+** button to invite someone with a room link.

## Pick up where you left off

Your personal workspace holds the rooms you've joined. Closing a tab keeps your membership, so you can come back to the same conversation and whiteboard later.

Invitation links work through sign-in and registration. Once signed in, you continue into the room you were invited to join. Separate tabs can use separate accounts within the same browser.

## Save the ideas you want to keep

Save a snapshot of the whiteboard to your personal gallery. Browse your images in a grid, open a larger preview, rename a snapshot, download it, or delete it.

Snapshots preserve the board at the moment you save it. They remain in your gallery after you leave a room or the room is dissolved. Cursor labels stay outside the saved image.

## Give every room a clear owner

The person who creates a room becomes its owner. Owners can manage members, remove someone from the room, restore invitation access, transfer ownership, or dissolve the room.

Going offline preserves ownership. When an owner permanently leaves, they can choose a successor. If they leave that choice open, Roomline randomly selects a remaining member. The room receives an announcement, and the new owner receives a notification, including when they next return from being offline.

## Make the workspace your own

Set a display name, upload an avatar, and update your password from personal settings. Accounts without an uploaded image receive a default avatar with a simple filled silhouette and a coordinated background.

The layout adapts to desktop and smaller screens, keeping drawing tools, messages, and member controls accessible.

## Start using Roomline

Requires **Python 3.10 or later**.

```sh
python -m pip install -r requirements.txt
python server.py
```

Open [Roomline on your computer](http://127.0.0.1:8765), create an account, and select **Create room**. Share the invitation link to bring in another member.

On Windows, you can also double-click `start.bat` after installing the dependencies.

<details>
<summary>Connect from another computer on the same network</summary>

Start the server with `ROOMLINE_HOST` set to `0.0.0.0`. In PowerShell:

```powershell
$env:ROOMLINE_HOST = "0.0.0.0"
python server.py
```

Open the host computer's LAN IP address on port 8765 from the other computer, such as `http://192.168.1.100:8765`. Use your host's actual address, allow the connection through its firewall, and create invitation links from that address. The host must remain running.

</details>

<details>
<summary>Technical details and testing</summary>

Roomline uses a browser frontend, Flask, and SQLite. Server-Sent Events deliver room updates, and HTTP requests send chat and drawing operations. Server-side checks enforce membership, ownership, and access to personal snapshots. Passwords are hashed, and session cookies are HttpOnly and SameSite.

The application creates `roomline.db` beside `server.py`. `ROOMLINE_DB` and `ROOMLINE_PORT` can override the database path and listening port. The database is excluded from the source repository and ZIP package.

Run the backend integration tests:

```sh
python -B -m unittest -v test_server
```

For the optional browser tests, install Playwright and Chromium, start Roomline with a disposable test database, then run:

```sh
npm install --no-save playwright
npx playwright install chromium
node test_browser.cjs
```

`ROOMLINE_TEST_URL` overrides the browser tests' base URL. Browser tests create sample accounts and room content.

This version is designed for local and trusted LAN use with small groups. The chat panel displays the latest 300 messages per room. Internet deployment requires HTTPS and a production WSGI server. Presence tracking runs in one server process.

</details>

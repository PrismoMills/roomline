"use strict";

let sessionId = sessionStorage.getItem("roomline_session_id");
const sessionUrl = (url) => url + (url.includes("?") ? "&" : "?") + "session_id=" + encodeURIComponent(sessionId || "");
const root = document.querySelector("#app");
const modal = document.querySelector("#modal");
const modalContent = document.querySelector("#modal-content");
let notificationLoading = false;

async function checkOwnerNotification() {
  if (!user || modal.open || notificationLoading) return;
  notificationLoading = true;
  try {
    const data = await api('/notifications');
    if (!data.notifications.length || modal.open) return;
    const notice = data.notifications[0];
    showModal(`<div class="modal-body">${modalHeader('You are the new room owner')}<p>${esc(notice.content)}</p><p>You can now manage members, transfer ownership, and clear the shared whiteboard.</p><div class="modal-footer"><button class="btn primary" id="ack-owner">Got it</button></div></div>`);
    const acknowledge = () => api(`/notifications/${notice.id}/read`, 'POST', {}).catch(error => toast(error.message));
    modal.addEventListener('close', acknowledge, {once:true});
    document.querySelector('#ack-owner').onclick = () => modal.close();
  } catch (error) { toast(error.message); }
  finally { notificationLoading = false; }
}
const paths = {
  board: "M4 4h16v13H4z M8 21l4-4 4 4 M8 8h8 M8 12h5",
  rooms: "M3 5h18v12H8l-5 4z M7 9h10 M7 13h6",
  gallery: "M3 4h18v16H3z M3 16l6-6 5 5 3-3 4 4 M16 8h.01",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M18 6L6 18",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  logout: "M10 3H4v18h6 M8 12h13 M17 8l4 4-4 4",
  users:
    "M9 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 20v-3c0-6 12-6 12 0v3 M16 4a3 3 0 0 1 0 6 M19 13q3 1 3 7",
  link: "M10 14l4-4 M9 16l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 6 0 M15 8l2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-6 0",
  pen: "M4 16L16 4l4 4L8 20H4z M14 6l4 4",
  eraser: "M3 14L13 4l8 8-9 9H9z M8 9l8 8 M12 21h9",
  line: "M4 20L20 4",
  rectangle: "M4 5h16v14H4z",
  undo: "M8 5l-5 5 5 5 M3 10h11a6 6 0 0 1 0 12",
  save: "M4 3h14l3 3v15H3V3z M7 3v7h10V3 M7 21v-7h10v7",
  trash: "M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  expand: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.board}"/></svg>`;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let user = null,
  section = "rooms",
  roomId = null,
  room = null,
  members = [],
  messages = [],
  strokes = [];
let rooms = [],
  snapshots = [],
  source = null,
  currentStroke = null,
  canvas = null,
  ctx = null;
let tool = "pen",
  color = "#35445e",
  width = 3,
  toastTimer,
  refreshTimer,
  avatarVersion = Date.now();
let previewIndex = 0,
  pendingInvite = new URLSearchParams(location.search).get("invite");
let connected = false,
  sending = false,
  activeRoomGeneration = 0;
const previews = new Map();
let localCursor = null, cursorTimer = null, cursorLastSent = 0, cursorRequestPending = false;
let remoteCursors = [];

function drawCursors() {
  const layer = document.querySelector('#cursor-layer');
  if (!layer) return;
  const cursors = remoteCursors.filter(cursor => cursor.user_id !== user.id);
  if (localCursor) cursors.push({...localCursor, user_id:user.id, username:user.username});
  layer.innerHTML = cursors.map(cursor => {
    const colors = ['#5579cf', '#aa71bc', '#479780', '#c28b4b', '#bd7180'];
    const index = parseInt(cursor.user_id.slice(0,6),16) % colors.length;
    return `<div class="board-cursor" data-user="${esc(cursor.username)}" style="left:${cursor.x*100}%;top:${cursor.y*100}%;--cursor-color:${colors[index]}"><span class="cursor-dot"></span><span class="cursor-label ${cursor.x>.78?'label-left':''} ${cursor.y>.88?'label-above':''}">${esc(cursor.username)}</span></div>`;
  }).join('');
}

async function sendCursor(force=false) {
  if (!roomId || !connected || cursorRequestPending || (!force && Date.now()-cursorLastSent<80)) return;
  cursorLastSent = Date.now(); cursorRequestPending = true;
  const id = roomId;
  const sentCursor = localCursor;
  try { await api(`/rooms/${id}/cursor`, 'POST', sentCursor ? {visible:true,...sentCursor} : {visible:false}); }
  catch { /* The live connection will recover after a temporary disconnect. */ }
  finally {
    cursorRequestPending = false;
    if (roomId===id && localCursor!==sentCursor) sendCursor(true);
  }
}

function moveCursor(event) {
  const rect = canvas.getBoundingClientRect();
  const inside = event.clientX>=rect.left && event.clientX<=rect.right && event.clientY>=rect.top && event.clientY<=rect.bottom;
  if (!inside) { leaveCursor(); return; }
  const [x,y] = point(event); localCursor = {x,y}; drawCursors(); sendCursor();
}

function leaveCursor() {
  localCursor = null; drawCursors(); sendCursor(true);
}
let lastPreview = 0;
const brand = () =>
  `<div class="brand"><span class="brand-mark">${icon("board")}</span><span>roomline</span></div>`;
const avatar = (person, size = "") =>
  `<img class="avatar ${size}" src="${sessionUrl(`/avatar/${esc(person.id)}?v=${avatarVersion}`)}" alt="${esc(person.nickname)}">`;
const stamp = (seconds) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const clock = (seconds) =>
  new Date(seconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

async function api(path, method = "GET", body) {
  const response = await fetch("/api" + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(sessionId ? { "X-Roomline-Session": sessionId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && user) {
      user = null;
      stopRoom();
      renderAuth();
    }
    throw new Error(data.error || "The operation failed.");
  }
  return data;
}
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}
function showModal(content, large = false) {
  modal.classList.toggle("lightbox-dialog", large);
  modalContent.innerHTML = content;
  if (!modal.open) modal.showModal();
}
function modalHeader(title) {
  return `<div class="modal-top"><h2>${esc(title)}</h2><button class="tool-icon" data-action="close-modal" aria-label="Close">${icon("close")}</button></div>`;
}
function confirmAction(title, description, action, destructive = true) {
  showModal(
    `<div class="modal-body">${modalHeader(title)}<p>${esc(description)}</p><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button id="confirm" class="btn ${destructive ? "danger" : "primary"}">${esc(title)}</button></div></div>`,
  );
  document.querySelector("#confirm").onclick = async (event) => {
    event.target.disabled = true;
    try {
      await action();
      if (modal.open) modal.close();
    } catch (error) {
      toast(error.message);
      event.target.disabled = false;
    }
  };
}
function roomRequest(action, data = {}) {
  return api(`/rooms/${roomId}/${action}`, "POST", data);
}

function renderAuth(register = false) {
  root.innerHTML = `<div class="auth-layout"><aside class="auth-art">${brand()}<div><div class="eyebrow">A shared space for ideas</div><h1>Good ideas<br>come together.</h1><p>A canvas for your thoughts. A conversation that keeps them moving.</p><div class="auth-illustration">${icon("board")}</div></div><footer>Draw together. Think together.</footer></aside><section class="auth-main"><form class="auth-form" id="auth-form"><h1>${register ? "Make room for your ideas." : "Welcome back."}</h1><p>${register ? "Create your account to start a shared workspace." : "Sign in to pick up where you left off."}</p><div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" placeholder="Your username"></div>${register ? '<div class="field"><label for="nickname">Display name</label><input id="nickname" name="nickname" autocomplete="nickname" required maxlength="40" placeholder="What should we call you?"></div>' : ""}<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" required minlength="8" maxlength="128" placeholder="At least 8 characters"></div><p class="error" id="auth-error" role="alert"></p><button class="btn primary" type="submit">${register ? "Create account" : "Sign in"}</button><div class="auth-switch">${register ? "Already have an account?" : "New to Roomline?"} <button type="button" class="text-button" id="auth-switch">${register ? "Sign in" : "Create an account"}</button></div></form></section></div>`;
  document.querySelector("#auth-switch").onclick = () => renderAuth(!register);
  document.querySelector("#auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.target));
      const login = await api(register ? "/register" : "/login", "POST", data);
      sessionId = login.session_id;
      sessionStorage.setItem("roomline_session_id", sessionId);
      user = login.user;
      if (pendingInvite) await acceptInvite();
      else await renderWorkspace();
    } catch (error) {
      document
        .querySelector("#auth-error")
        ?.replaceChildren(document.createTextNode(error.message));
    } finally {
      button.disabled = false;
    }
  };
}

function stopRoom() {
  if (roomId && localCursor) api(`/rooms/${roomId}/cursor`, 'POST', {visible:false}).catch(()=>{});
  clearInterval(cursorTimer); cursorTimer=null; localCursor=null; remoteCursors=[];
  activeRoomGeneration++;
  source?.close();
  source = null;
  clearTimeout(refreshTimer);
  currentStroke = null;
  window.removeEventListener("resize", resizeCanvas);
  roomId = null;
  room = null;
  connected = false;
  previews.clear();
}
async function renderWorkspace(next = section) {
  stopRoom();
  section = next;
  history.replaceState(null, "", "/");
  const names = {
    rooms: "Joined rooms",
    snapshots: "Saved snapshots",
    settings: "Personal settings",
  };
  root.innerHTML = `<div class="shell"><aside class="sidebar">${brand()}<div class="side-label eyebrow">Workspace</div><nav class="nav">${Object.entries(
    names,
  )
    .map(
      ([key, label]) =>
        `<button data-section="${key}" class="${section === key ? "active" : ""}">${icon(key === "snapshots" ? "gallery" : key)}${label}</button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div class="user-block">${avatar(user)}<div><strong>${esc(user.nickname)}</strong><small class="muted">@${esc(user.username)}</small></div></div><button class="btn" data-action="logout">${icon("logout")}Sign out</button></div></aside><section class="workspace"><header class="topbar"><span class="breadcrumb">My workspace / ${names[section]}</span><div class="top-right"><span class="muted">${new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><button data-section="settings" class="tool-icon" title="Personal settings">${avatar(user)}</button></div></header><div id="workspace-content"></div></section></div>`;
  if (section === "rooms") await loadRooms();
  if (section === "snapshots") await loadSnapshots();
  if (section === "settings") renderSettings();
  await checkOwnerNotification();
}
async function loadRooms() {
  rooms = (await api("/rooms")).rooms;
  document.querySelector("#workspace-content").innerHTML =
    `<div class="heading-row"><div><h1>Your rooms</h1><p>A little space for your next big idea.</p></div><div class="actions"><button class="btn" data-action="join-room">${icon("link")}Join a room</button><button class="btn primary" data-action="create-room">${icon("plus")}Create room</button></div></div><div class="search">${icon("search")}<input id="room-search" placeholder="Find a room" aria-label="Find a room"></div><div id="room-grid" class="room-grid"></div>`;
  renderRoomCards(rooms);
  document.querySelector("#room-search").oninput = (event) =>
    renderRoomCards(
      rooms.filter((r) =>
        r.name.toLowerCase().includes(event.target.value.toLowerCase()),
      ),
    );
}
function renderRoomCards(list) {
  document.querySelector("#room-grid").innerHTML = list.length
    ? list
        .map(
          (r) =>
            `<button class="room-card" data-room="${r.id}"><div class="room-cover">${icon("board")}</div><div class="room-detail"><h3>${esc(r.name)}</h3><p>${r.owner === user.id ? "You own this room" : "Shared workspace"} · Updated ${stamp(r.activity)}</p><div class="room-meta"><span>${icon("users")}${r.member_count} member${r.member_count === 1 ? "" : "s"}</span><span>${r.online} online</span></div></div></button>`,
        )
        .join("")
    : `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">${icon("rooms")}</div><h2>${rooms.length ? "No matching rooms" : "Your first room starts here"}</h2><p>${rooms.length ? "Try another room name." : "Create a room for your team, or join one with an invitation link."}</p>${rooms.length ? "" : '<button class="btn primary" data-action="create-room">Create a room</button>'}</div>`;
}
function createRoomModal() {
  showModal(
    `<form id="create-form" class="modal-body">${modalHeader("Create a room")}<p>Bring your team together around one shared canvas.</p><div class="field"><label for="room-name">Room name</label><input id="room-name" name="name" maxlength="70" required placeholder="e.g. Design studio"></div><div class="modal-footer"><button class="btn primary">Create room</button></div></form>`,
  );
  document.querySelector("#create-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = await api(
      "/rooms",
      "POST",
      Object.fromEntries(new FormData(event.target)),
    );
    modal.close();
    await enterRoom(data.id);
  };
}
function joinRoomModal() {
  showModal(
    `<form id="join-form" class="modal-body">${modalHeader("Join a room")}<p>Paste the invitation link shared by a member.</p><div class="field"><label for="invite">Invitation link</label><input id="invite" name="invite" required placeholder="https://.../?invite=..."></div><div class="modal-footer"><button class="btn primary">Join room</button></div></form>`,
  );
  document.querySelector("#join-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = await api(
      "/join",
      "POST",
      Object.fromEntries(new FormData(event.target)),
    );
    modal.close();
    await enterRoom(data.id);
  };
}
async function acceptInvite() {
  try {
    const data = await api("/join", "POST", { invite: pendingInvite });
    pendingInvite = null;
    await enterRoom(data.id);
  } catch (error) {
    pendingInvite = null;
    await renderWorkspace();
    toast(error.message);
  }
}
function renderSettings() {
  document.querySelector("#workspace-content").innerHTML =
    `<div class="heading-row"><div><h1>Make it yours</h1><p>Your profile, wherever the conversation takes you.</p></div></div><form id="settings-form" class="settings-card"><div class="profile-avatar">${avatar(user, "large")}<div><label class="eyebrow" for="avatar-file">Profile picture</label><p class="muted" style="font-size:.8rem;margin:7px 0">PNG or JPEG, up to 6 MB</p><input id="avatar-file" type="file" accept="image/png,image/jpeg"></div></div><div class="field"><label>Username</label><input value="${esc(user.username)}" disabled></div><div class="field"><label for="display-name">Display name</label><input id="display-name" name="nickname" required maxlength="40" value="${esc(user.nickname)}"></div><div class="field"><label for="current-password">Current password</label><input id="current-password" name="current_password" type="password" autocomplete="current-password" placeholder="Required only when changing password"></div><div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" placeholder="Leave blank to keep your password"></div><button class="btn primary">Save changes</button></form>`;
  document.querySelector("#settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.target));
      const file = document.querySelector("#avatar-file").files[0];
      if (file) {
        if (file.size > 6 * 1024 * 1024)
          throw new Error("Choose an image smaller than 6 MB.");
        data.avatar = await fileData(file);
      }
      user = (await api("/profile", "POST", data)).user;
      avatarVersion = Date.now();
      await renderWorkspace("settings");
      toast("Profile updated.");
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
}
function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

async function loadSnapshots() {
  snapshots = (await api("/snapshots")).snapshots;
  document.querySelector("#workspace-content").innerHTML =
    `<div class="heading-row"><div><h1>Saved snapshots</h1><p>The ideas you chose to keep.</p></div><span class="muted">${snapshots.length} saved</span></div><div class="snapshot-grid">${snapshots.length ? snapshots.map((s, index) => `<article class="snapshot"><div class="snapshot-image"><button data-preview="${index}" aria-label="Open ${esc(s.name)}"><img src="${sessionUrl(`/api/snapshots/${s.id}/image`)}" alt="${esc(s.name)}" loading="lazy"></button><div class="snapshot-tools"><button class="tool-icon" data-preview="${index}" aria-label="Enlarge">${icon("expand")}</button><button class="tool-icon" data-download="${index}" aria-label="Download">${icon("download")}</button><button class="tool-icon" data-delete-snapshot="${index}" aria-label="Delete">${icon("trash")}</button></div></div><div class="snapshot-detail"><h3>${esc(s.name)}</h3><p>${esc(s.room_name)} · ${stamp(s.created)}</p></div></article>`).join("") : `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">${icon("gallery")}</div><h2>Keep a moment of clarity</h2><p>Save a snapshot from any room's whiteboard. Your images will appear here, even after you leave the room.</p><button class="btn" data-section="rooms">Browse your rooms</button></div>`}</div>`;
}
function preview(index) {
  if (!snapshots.length) {
    modal.close();
    return;
  }
  previewIndex = (index + snapshots.length) % snapshots.length;
  const s = snapshots[previewIndex];
  showModal(
    `<div class="lightbox-head"><div><h3>${esc(s.name)}</h3><small>${esc(s.room_name)} · ${stamp(s.created)}</small></div><div class="actions"><button class="btn" data-action="rename-snapshot">Rename</button><button class="btn" data-download="${previewIndex}">${icon("download")}Download</button><button class="btn danger" data-delete-snapshot="${previewIndex}">${icon("trash")}Delete</button><button class="tool-icon" data-action="close-modal" aria-label="Close">${icon("close")}</button></div></div><div class="lightbox-picture"><img src="${sessionUrl(`/api/snapshots/${s.id}/image`)}" alt="${esc(s.name)}"></div><div class="lightbox-bottom"><button class="btn" data-action="previous-snapshot">Previous</button><span>${previewIndex + 1} / ${snapshots.length}</span><button class="btn" data-action="next-snapshot">Next</button></div>`,
    true,
  );
}
async function downloadSnapshot(index) {
  const s = snapshots[index];
  const response = await fetch(sessionUrl(`/api/snapshots/${s.id}/image`));
  if (!response.ok) throw new Error("Could not download the image.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = s.name.replace(/[<>:"/\\|?*]/g, "_") + ".png";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function deleteSnapshot(index) {
  const s = snapshots[index];
  const wasPreview = modal.classList.contains("lightbox-dialog");
  showModal(
    `<div class="modal-body">${modalHeader("Delete snapshot")}<p>Delete “${esc(s.name)}” from your saved images?</p><div class="modal-footer"><button class="btn" id="cancel-delete">Cancel</button><button class="btn danger" id="confirm-delete">Delete snapshot</button></div></div>`,
  );
  document.querySelector("#cancel-delete").onclick = () =>
    wasPreview ? preview(index) : modal.close();
  document.querySelector("#confirm-delete").onclick = async () => {
    await api("/snapshots/" + s.id, "DELETE");
    await loadSnapshots();
    if (wasPreview && snapshots.length)
      preview(Math.min(index, snapshots.length - 1));
    else modal.close();
    toast("Snapshot deleted.");
  };
}
function renameSnapshot() {
  const index = previewIndex,
    s = snapshots[index];
  showModal(
    `<form id="rename-form" class="modal-body">${modalHeader("Rename snapshot")}<div class="field"><label for="snapshot-name">Name</label><input id="snapshot-name" name="name" maxlength="100" required value="${esc(s.name)}"></div><div class="modal-footer"><button class="btn primary">Save name</button></div></form>`,
  );
  document.querySelector("#rename-form").onsubmit = async (event) => {
    event.preventDefault();
    await api(
      "/snapshots/" + s.id,
      "PATCH",
      Object.fromEntries(new FormData(event.target)),
    );
    await loadSnapshots();
    preview(index);
  };
}

async function enterRoom(id) {
  stopRoom();
  const generation = activeRoomGeneration;
  roomId = id;
  try {
    const data = await api("/rooms/" + id);
    if (generation !== activeRoomGeneration) return;
    room = data.room;
    members = data.members;
    messages = data.messages;
    strokes = data.strokes;
    history.replaceState(null, "", `/?room=${id}`);
    renderRoom();
    subscribe(data.cursor);
    await checkOwnerNotification();
  } catch (error) {
    await renderWorkspace();
    toast(error.message);
  }
}
function renderRoom() {
  root.innerHTML = `<div class="room-app"><header class="room-header"><div class="room-title"><button class="back-btn" data-section="rooms" title="Back to workspace">${brand()}</button><div class="room-name"><h2 id="room-name-title">${esc(room.name)}</h2><small>Shared room · ${room.id}</small></div></div><div class="actions"><span id="connection" class="connection reconnecting">Connecting</span><button class="btn" data-action="invite">${icon("link")}Invite</button><button class="tool-icon" data-action="room-menu" aria-label="Room options">${icon("more")}</button></div></header><div class="room-layout"><section class="board-section"><div class="board-heading"><h3>${icon("board")}Shared whiteboard</h3><div class="board-actions"><button class="btn" data-action="undo" title="Undo your last drawing">${icon("undo")}Undo</button><button class="btn" id="clear-board" data-action="clear-board">${icon("trash")}Clear</button><button class="btn primary" data-action="snapshot">${icon("save")}Save snapshot</button></div></div><div class="board-stage"><div class="canvas-frame" id="canvas-frame"><canvas id="canvas" width="1600" height="1000" aria-label="Shared drawing canvas"></canvas></div></div><div class="draw-toolbar" role="toolbar" aria-label="Drawing tools">${["pen", "eraser", "line", "rectangle"].map((t) => `<button class="draw-tool ${tool === t ? "active" : ""}" data-tool="${t}" title="${t}" aria-label="${t}">${icon(t)}</button>`).join("")}<span class="toolbar-divider"></span>${["#35445e", "#4566e8", "#ba68ba", "#e6964a", "#42a58a"].map((c) => `<button class="color ${color === c ? "active" : ""}" style="background:${c}" data-color="${c}" title="${c}" aria-label="Color ${c}"></button>`).join("")}<span class="toolbar-divider"></span><input id="stroke-width" type="range" min="1" max="24" value="${width}" aria-label="Stroke width" title="Stroke width"></div><footer class="board-footer"><span>One canvas. Everyone's ideas.</span><span id="board-status">All changes saved</span></footer></section><aside class="chat-panel"><div class="members-header"><div class="members-title"><strong>Members</strong><span id="member-count" class="muted"></span></div><div id="member-strip" class="member-strip"></div></div><div class="chat-heading">${icon("rooms")}Conversation</div><div id="messages" class="messages" aria-live="polite"></div><form id="composer" class="composer"><textarea id="message-input" placeholder="Share a thought…" aria-label="Message" maxlength="4000" rows="2" required></textarea><div class="composer-bottom"><span>Enter to send · Shift + Enter for a new line</span><button class="send" type="submit">Send</button></div></form></aside></div></div>`;
  renderMembers();
  renderMessages();
  canvas = document.querySelector("#canvas");
  ctx = canvas.getContext("2d");
  drawBoard();
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerCancel);
  const layer = document.createElement('div');
  layer.id='cursor-layer'; layer.setAttribute('aria-hidden','true');
  document.querySelector('#canvas-frame').append(layer);
  canvas.addEventListener('pointerenter', moveCursor);
  canvas.addEventListener('pointerleave', leaveCursor);
  cursorTimer = setInterval(()=>{if(localCursor)sendCursor(true);},2000);
  document.querySelector("#stroke-width").oninput = (event) =>
    (width = +event.target.value);
  document.querySelector("#composer").onsubmit = sendMessage;
  document.querySelector("#message-input").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.querySelector("#composer").requestSubmit();
    }
  };
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
}
function renderMembers() {
  const strip = document.querySelector("#member-strip");
  if (!strip) return;
  document.querySelector("#member-count").textContent =
    `${members.filter((m) => m.online).length} online · ${members.length} total`;
  // Four avatar slots are fixed; overflow and invite controls always occupy the end.
  strip.innerHTML =
    members
      .slice(0, 4)
      .map(
        (person) =>
          `<button data-action="members" title="${esc(person.nickname)}${person.id === room.owner ? " · Owner" : ""}"><span class="avatar-wrap"><img class="avatar ${person.online ? "" : "offline"}" src="${sessionUrl(`${person.avatar}?v=${avatarVersion}`)}" alt="${esc(person.nickname)}"><span class="presence-dot ${person.online ? "" : "off"}"></span>${person.id === room.owner ? '<span class="crown" title="Owner">★</span>' : ""}</span></button>`,
      )
      .join("") +
    (members.length > 4
      ? '<button class="member-circle" data-action="members" aria-label="All members">…</button>'
      : "") +
    '<button class="member-circle" data-action="invite" aria-label="Invite a member">+</button>';
  document
    .querySelector("#clear-board")
    .classList.toggle("hidden", room.owner !== user.id);
}
function renderMessages() {
  const container = document.querySelector("#messages");
  if (!container) return;
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  container.innerHTML = messages
    .map((message) =>
      message.system
        ? `<div class="system-message">${esc(message.content)}</div>`
        : `<div class="message ${message.user_id === user.id ? "own" : ""}"><img class="avatar" src="${sessionUrl(`/avatar/${message.user_id}?v=${avatarVersion}`)}" alt=""><div class="message-body"><div class="message-name"><span>${esc(message.nickname)}</span><time>${clock(message.created)}</time></div><div class="message-text">${esc(message.content)}</div></div></div>`,
    )
    .join("");
  if (nearBottom || !container.dataset.loaded) {
    container.scrollTop = container.scrollHeight;
    container.dataset.loaded = "1";
  }
}
async function sendMessage(event) {
  event.preventDefault();
  if (sending || !connected) {
    if (!connected) toast("Wait for the connection to recover.");
    return;
  }
  const field = document.querySelector("#message-input");
  const content = field.value.trim();
  if (!content) return;
  sending = true;
  try {
    await roomRequest("message", { content });
    field.value = "";
  } catch (error) {
    toast(error.message);
  } finally {
    sending = false;
  }
}
function subscribe(cursor) {
  source?.close();
  source = new EventSource(sessionUrl(`/api/rooms/${roomId}/events?after=${cursor}`));
  source.onopen = () => {
    connected = true;
    setConnection("Connected", false);
  };
  source.onerror = () => {
    connected = false;
    setConnection("Reconnecting", true);
  };
  source.addEventListener('cursors', event => {
    remoteCursors = JSON.parse(event.data); drawCursors();
  });
  source.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (!messages.some((m) => m.id === data.id)) {
      messages.push(data);
      messages = messages.slice(-300);
      renderMessages();
    }
    const person = members.find((m) => m.id === data.user_id);
    if (person) {
      person.spoken = data.id;
      members.sort((a, b) => b.spoken - a.spoken);
      renderMembers();
    }
  });
  source.addEventListener("stroke", (event) => {
    const data = JSON.parse(event.data);
    data.sequence = +event.lastEventId;
    previews.delete(data.id);
    strokes = strokes.filter((s) => s.id !== data.id);
    strokes.push(data);
    strokes.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
    drawBoard();
  });
  source.addEventListener("preview", (event) => {
    const data = JSON.parse(event.data);
    if (data.user_id !== user.id && !strokes.some((s) => s.id === data.id)) {
      previews.set(data.id, { ...data, expires: Date.now() + 15000 });
      drawBoard();
    }
  });
  source.addEventListener("undo", (event) => {
    const data = JSON.parse(event.data);
    strokes = strokes.filter((s) => s.id !== data.id);
    drawBoard();
  });
  source.addEventListener("clear", () => {
    strokes = [];
    previews.clear();
    drawBoard();
  });
  for (const kind of ["refresh", "members"])
    source.addEventListener(kind, scheduleRefresh);
  source.addEventListener("removed", (event) => {
    if (JSON.parse(event.data).user_id === user.id) revoked();
    else scheduleRefresh();
  });
  source.addEventListener("dissolved", revoked);
  source.addEventListener('owner_changed', event => {
    const data = JSON.parse(event.data);
    toast(data.content);
    scheduleRefresh();
    if (data.user_id === user.id) checkOwnerNotification();
  });
  source.addEventListener("revoked", revoked);
}
function setConnection(label, reconnecting) {
  const el = document.querySelector("#connection");
  if (el) {
    el.textContent = label;
    el.classList.toggle("reconnecting", reconnecting);
  }
}
async function revoked() {
  source?.close();
  await renderWorkspace();
  toast("This room is unavailable, or your membership has ended.");
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshRoom, 120);
}
async function refreshRoom() {
  const id = roomId,
    generation = activeRoomGeneration;
  if (!id) return;
  try {
    const data = await api("/rooms/" + id);
    if (generation !== activeRoomGeneration) return;
    room = data.room;
    members = data.members;
    messages = data.messages;
    // Events already received after this snapshot remain safe through idempotent drawing IDs.
    renderMembers();
    renderMessages();
  } catch (error) {
    if (generation === activeRoomGeneration) await revoked();
  }
}
function inviteModal() {
  const url = `${location.origin}/?invite=${room.invite}`;
  showModal(
    `<div class="modal-body">${modalHeader("Make room for someone")}<p>Share this link to invite someone to <strong>${esc(room.name)}</strong>. They can sign in or create an account to join.</p><div class="field"><label for="invite-link">Room invitation link</label><div class="copy-row"><input id="invite-link" readonly value="${esc(url)}"><button class="btn primary" id="copy-invite">Copy link</button></div></div></div>`,
  );
  document.querySelector("#copy-invite").onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("Invitation link copied.");
    } catch {
      document.querySelector("#invite-link").select();
      document.execCommand("copy");
      toast("Invitation link selected for copying.");
    }
  };
}
async function membersModal() {
  await refreshRoom();
  if (!room) return;
  const isOwner = room.owner === user.id;
  const bans = isOwner ? (await api(`/rooms/${roomId}/bans`)).members : [];
  showModal(
    `<div class="modal-body">${modalHeader("Room members")}<div class="members-list">${members.map((person) => `<div class="member-row"><span class="avatar-wrap">${avatar(person)}<span class="presence-dot ${person.online ? "" : "off"}"></span></span><div class="info"><strong>${esc(person.nickname)} ${person.id === room.owner ? "· Owner" : ""}</strong><small>@${esc(person.username)} · ${person.online ? "Online" : "Offline"}</small></div>${isOwner && person.id !== user.id ? `<button class="btn" data-transfer="${person.id}">Make owner</button><button class="btn danger" data-kick="${person.id}">Remove</button>` : ""}</div>`).join("")}${bans.length ? '<h3 style="margin-top:22px">Removed members</h3>' + bans.map((person) => `<div class="member-row">${avatar(person)}<div class="info"><strong>${esc(person.nickname)}</strong><small>Invitation access blocked</small></div><button class="btn" data-restore="${person.id}">Allow rejoining</button></div>`).join("") : ""}</div></div>`,
  );
}
function roomMenu() {
  showModal(
    `<div class="modal-body">${modalHeader("Room options")}<div class="room-menu"><button class="btn" data-action="members">${icon("users")}Manage members</button><button class="btn" data-section="rooms">${icon("rooms")}Back to my workspace</button><button class="btn danger" data-action="leave">${icon("logout")}Leave this room permanently</button>${room.owner === user.id ? '<button class="btn danger" data-action="dissolve">' + icon("trash") + "Dissolve room for everyone</button>" : ""}</div></div>`,
  );
}
function leaveModal() {
  const peers = members.filter((m) => m.id !== user.id);
  const owner = room.owner === user.id;
  showModal(
    `<form id="leave-form" class="modal-body">${modalHeader("Leave this room?")}<p>You will leave the member list. Your personal snapshots remain saved.${owner && !peers.length ? " As the last member, leaving will also close the room." : ""}</p>${owner && peers.length ? `<div class="field"><label for="successor">Next owner</label><select id="successor" name="successor"><option value="">Choose a remaining member at random</option>${peers.map((p) => `<option value="${p.id}">${esc(p.nickname)}</option>`).join("")}</select></div>` : ""}<div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn danger">Leave room</button></div></form>`,
  );
  document.querySelector("#leave-form").onsubmit = async (event) => {
    event.preventDefault();
    await roomRequest("manage", {
      action: "leave",
      ...Object.fromEntries(new FormData(event.target)),
    });
    modal.close();
    await renderWorkspace();
  };
}

function resizeCanvas() {
  const frame = document.querySelector("#canvas-frame"),
    stage = document.querySelector(".board-stage");
  if (!frame || !stage) return;
  const w = Math.min(stage.clientWidth, stage.clientHeight * 1.6);
  frame.style.width = w + "px";
  frame.style.height = w / 1.6 + "px";
}
function point(event) {
  const rect = canvas.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  ];
}
function pointerDown(event) {
  if (!connected) {
    toast("Wait for the connection to recover.");
    return;
  }
  if (event.button !== 0 || currentStroke) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  currentStroke = {
    id: crypto.randomUUID(),
    tool,
    color,
    width,
    points: [point(event)],
    pointer: event.pointerId,
  };
  document.querySelector("#board-status").textContent = "Drawing…";
  drawBoard();
}
function pointerMove(event) {
  moveCursor(event);
  if (!currentStroke || event.pointerId !== currentStroke.pointer) return;
  const p = point(event);
  if (["line", "rectangle"].includes(currentStroke.tool))
    currentStroke.points[1] = p;
  else if (currentStroke.points.length < 11999) currentStroke.points.push(p);
  if (Date.now() - lastPreview > 140) {
    lastPreview = Date.now();
    const { pointer, ...preview } = currentStroke;
    api(`/rooms/${roomId}/preview`, "POST", preview).catch(() => {});
  }
  drawBoard();
}
async function pointerUp(event) {
  if (!currentStroke || event.pointerId !== currentStroke.pointer) return;
  pointerMove(event);
  const stroke = currentStroke;
  delete stroke.pointer;
  currentStroke = null;
  strokes.push({ ...stroke, user_id: user.id });
  drawBoard();
  const id = roomId;
  document.querySelector("#board-status").textContent = "Saving stroke…";
  try {
    await api(`/rooms/${id}/stroke`, "POST", stroke);
    if (id === roomId)
      document.querySelector("#board-status").textContent = "All changes saved";
  } catch (error) {
    if (id === roomId) {
      strokes = strokes.filter((s) => s.id !== stroke.id);
      drawBoard();
      document.querySelector("#board-status").textContent = "Stroke not saved";
    }
    toast(error.message);
  }
}
function pointerCancel(event) {
  if (currentStroke) pointerUp(event);
}
function drawStroke(stroke, context = ctx) {
  const p = stroke.points;
  if (!p.length) return;
  context.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
  context.fillStyle = context.strokeStyle;
  context.lineWidth =
    stroke.tool === "eraser" ? stroke.width * 3 : stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  const x = p[0][0] * 1600,
    y = p[0][1] * 1000;
  if (stroke.tool === "rectangle" && p.length > 1) {
    context.strokeRect(
      x,
      y,
      (p[p.length - 1][0] - p[0][0]) * 1600,
      (p[p.length - 1][1] - p[0][1]) * 1000,
    );
    return;
  }
  if (p.length === 1) {
    context.beginPath();
    context.arc(x, y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(x, y);
  for (const v of p.slice(1)) context.lineTo(v[0] * 1600, v[1] * 1000);
  context.stroke();
}
function drawBoard() {
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1600, 1000);
  strokes.forEach((s) => drawStroke(s));
  for (const [id, preview] of previews) {
    if (preview.expires > Date.now()) drawStroke(preview);
    else previews.delete(id);
  }
  if (currentStroke) drawStroke(currentStroke);
}
function saveSnapshotModal() {
  if (currentStroke) {
    toast("Finish your drawing first.");
    return;
  }
  const id = roomId,
    image = canvas.toDataURL("image/png");
  showModal(
    `<form id="save-snapshot-form" class="modal-body">${modalHeader("Save this moment")}<p>A copy of the current whiteboard will be saved to your personal gallery.</p><div class="field"><label for="save-name">Snapshot name</label><input id="save-name" name="name" required maxlength="100" value="${esc(room.name)} — ${new Date().toLocaleDateString()}"></div><div class="modal-footer"><button class="btn primary">Save snapshot</button></div></form>`,
  );
  document.querySelector("#save-snapshot-form").onsubmit = async (event) => {
    event.preventDefault();
    await api("/snapshots", "POST", {
      room_id: id,
      image,
      ...Object.fromEntries(new FormData(event.target)),
    });
    modal.close();
    toast("Snapshot saved to your gallery.");
  };
}

async function handleClick(event) {
  const el = event.target.closest("button");
  if (!el) return;
  try {
    if (el.dataset.section) {
      if (modal.open) modal.close();
      await renderWorkspace(el.dataset.section);
      return;
    }
    if (el.dataset.room) {
      await enterRoom(el.dataset.room);
      return;
    }
    if (el.dataset.preview !== undefined) {
      preview(+el.dataset.preview);
      return;
    }
    if (el.dataset.download !== undefined) {
      await downloadSnapshot(+el.dataset.download);
      return;
    }
    if (el.dataset.deleteSnapshot !== undefined) {
      deleteSnapshot(+el.dataset.deleteSnapshot);
      return;
    }
    if (el.dataset.tool) {
      tool = el.dataset.tool;
      document
        .querySelectorAll("[data-tool]")
        .forEach((b) => b.classList.toggle("active", b === el));
      return;
    }
    if (el.dataset.color) {
      color = el.dataset.color;
      document
        .querySelectorAll("[data-color]")
        .forEach((b) => b.classList.toggle("active", b === el));
      return;
    }
    if (el.dataset.kick) {
      const p = members.find((m) => m.id === el.dataset.kick);
      confirmAction(
        "Remove member",
        `Remove ${p.nickname}? Their invitation access will be blocked until you restore it.`,
        () => roomRequest("manage", { action: "kick", target: p.id }),
      );
      return;
    }
    if (el.dataset.transfer) {
      const p = members.find((m) => m.id === el.dataset.transfer);
      confirmAction(
        "Transfer ownership",
        `Make ${p.nickname} the owner of this room?`,
        () => roomRequest("manage", { action: "transfer", target: p.id }),
        false,
      );
      return;
    }
    if (el.dataset.restore) {
      await roomRequest("manage", {
        action: "restore",
        target: el.dataset.restore,
      });
      await membersModal();
      toast("This member can join again using the invitation link.");
      return;
    }
    switch (el.dataset.action) {
      case "logout":
        await api("/logout", "POST", {});
        sessionStorage.removeItem("roomline_session_id");
        sessionId = null;
        user = null;
        stopRoom();
        renderAuth();
        break;
      case "close-modal":
        modal.close();
        break;
      case "create-room":
        createRoomModal();
        break;
      case "join-room":
        joinRoomModal();
        break;
      case "invite":
        inviteModal();
        break;
      case "members":
        await membersModal();
        break;
      case "room-menu":
        roomMenu();
        break;
      case "leave":
        leaveModal();
        break;
      case "dissolve":
        confirmAction(
          "Dissolve room",
          "The room, conversation and whiteboard will become unavailable to all members. Personal snapshots will remain.",
          async () => {
            await roomRequest("manage", { action: "dissolve" });
            await renderWorkspace();
          },
        );
        break;
      case "undo":
        await roomRequest("undo");
        break;
      case "clear-board":
        confirmAction(
          "Clear whiteboard",
          "Clear the shared whiteboard for everyone?",
          () => roomRequest("clear"),
        );
        break;
      case "snapshot":
        saveSnapshotModal();
        break;
      case "previous-snapshot":
        preview(previewIndex - 1);
        break;
      case "next-snapshot":
        preview(previewIndex + 1);
        break;
      case "rename-snapshot":
        renameSnapshot();
        break;
    }
  } catch (error) {
    toast(error.message);
  }
}
document.addEventListener("click", handleClick);
// Form handlers report errors without losing the user's entered values.
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  toast(event.reason?.message || "The operation failed. Please try again.");
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) modal.close();
});
document.addEventListener("keydown", (event) => {
  if (modal.open && modal.classList.contains("lightbox-dialog")) {
    if (event.key === "ArrowLeft") preview(previewIndex - 1);
    if (event.key === "ArrowRight") preview(previewIndex + 1);
  }
});
async function boot() {
  if (!sessionId) { renderAuth(); return; }
  try {
    user = (await api("/me")).user;
    if (pendingInvite) {
      await acceptInvite();
      return;
    }
    const id = new URLSearchParams(location.search).get("room");
    if (id) await enterRoom(id);
    else await renderWorkspace();
  } catch {
    renderAuth();
  }
}
boot();

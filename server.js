// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const crypto = require("crypto");
const noblox = require("noblox.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- BASIC MIDDLEWARE ----------------
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ---------------- DATA STORES ----------------
const sessions = new Map();   // token -> { created, username }
const requests = [];          // immigration requests in memory

// ---------------- AUTH CONFIG (NO USERS IN CODE) ----------------
// ADMIN_ACCOUNTS = JSON string like:
//   [
//     {"username":"admin","password":"SuperSecret"},
//     {"username":"officer1","password":"OtherPass"}
//   ]
const ADMIN_ACCOUNTS_JSON = process.env.ADMIN_ACCOUNTS || "[]";

const USERS = {}; // username -> password
try {
  const arr = JSON.parse(ADMIN_ACCOUNTS_JSON);
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      if (entry && entry.username && entry.password) {
        USERS[entry.username] = entry.password;
      }
    }
  }
} catch (e) {
  console.error("[AUTH] Failed to parse ADMIN_ACCOUNTS:", e);
}

// ---------------- BLACKLIST GROUP CONFIG ----------------
// BLACKLISTED_GROUPS = "123456,789012"
const BLACKLISTED_GROUPS = (process.env.BLACKLISTED_GROUPS || "")
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((n) => !Number.isNaN(n));

// ---------------- ROBLOX RANKING CONFIG ----------------
// Must be set in Render environment variables
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";
const IMMIGRATION_GROUP_ID = parseInt(
  process.env.IMMIGRATION_GROUP_ID || "0",
  10
);
const IMMIGRATION_ROLE_ID = parseInt(
  process.env.IMMIGRATION_ROLE_ID || "0",
  10
);

// ---------------- SMALL HELPERS ----------------
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return p.substring(name.length + 1);
  }
  return null;
}

function createSession(res, username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { created: Date.now(), username });

  res.setHeader(
    "Set-Cookie",
    `auth=${token}; HttpOnly; Path=/; SameSite=Lax`
  );
}

function destroySession(req, res) {
  const token = getCookie(req, "auth");
  if (token) sessions.delete(token);
  res.setHeader(
    "Set-Cookie",
    "auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
  );
}

function requireAuth(req, res, next) {
  const token = getCookie(req, "auth");
  const session = token && sessions.get(token);
  if (!session) {
    return res.redirect("/login");
  }
  req.session = session;
  next();
}

// ---------------- ROBLOX LOGIN ----------------
async function initRoblox() {
  if (!ROBLOX_COOKIE) {
    console.warn("[ROBLOX] ROBLOX_COOKIE not set; ranking will be disabled.");
    return;
  }
  try {
    const user = await noblox.setCookie(ROBLOX_COOKIE);

    // TEMP: show exactly what noblox gives us
    console.log("[ROBLOX] Login result object:", user);
    console.log("[ROBLOX] Login result keys:", Object.keys(user));

    // once you see the fields in the logs, you can change this to something like:
    // console.log(`[ROBLOX] Logged in as ${user.name || user.Username} (ID: ${user.id || user.UserID})`);
  } catch (e) {
    console.error("[ROBLOX] Failed to log in with cookie:", e);
  }
}
// Call but don't block startup if it fails
initRoblox();

// ---------------- RANKING FUNCTION ----------------
async function rankRobloxUser(userId, desiredState) {
  if (!ROBLOX_COOKIE || !IMMIGRATION_GROUP_ID || !IMMIGRATION_ROLE_ID) {
    console.warn(
      "[RANKING] Missing ROBLOX_COOKIE / IMMIGRATION_GROUP_ID / IMMIGRATION_ROLE_ID; skipping rank."
    );
    return;
  }

  try {
    await noblox.setRank(IMMIGRATION_GROUP_ID, Number(userId), IMMIGRATION_ROLE_ID);
    console.log(
      `[RANKING] Ranked user ${userId} to rank ${IMMIGRATION_ROLE_ID} in group ${IMMIGRATION_GROUP_ID} (state="${desiredState}")`
    );
  } catch (e) {
    console.error("[RANKING] Failed to rank user:", userId, e);
  }
}

// ---------------- ROUTES: LOGIN ----------------
app.get("/login", (req, res) => {
  const html = `
  <html>
    <head>
      <title>DC Immigration Login</title>
      <style>
        body { font-family: Arial, sans-serif; background:#0b0b0f; color:#eee; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
        .card { background:#15151b; padding:30px; border-radius:8px; width:320px; box-shadow:0 0 20px rgba(0,0,0,0.6); }
        h1 { margin-top:0; font-size:22px; }
        label { display:block; margin-top:10px; font-size:14px; }
        input[type=text], input[type=password] { width:100%; padding:8px; margin-top:4px; border-radius:4px; border:1px solid #333; background:#1f1f27; color:#eee; }
        button { margin-top:15px; width:100%; padding:10px; border:none; border-radius:4px; background:#3478f6; color:white; font-weight:bold; cursor:pointer; }
        button:hover { background:#245fcb; }
        .hint { margin-top:10px; font-size:11px; color:#aaa; }
      </style>
    </head>
    <body>
      <form class="card" method="POST" action="/login">
        <h1>Staff Login</h1>
        <label>Username
          <input type="text" name="username" autofocus />
        </label>
        <label>Password
          <input type="password" name="password" />
        </label>
        <button type="submit">Login</button>
        <div class="hint">Use your assigned staff username and password.</div>
      </form>
    </body>
  </html>
  `;
  res.send(html);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  const expected = USERS[username];
  if (expected && password === expected) {
    createSession(res, username);
    return res.redirect("/panel");
  }

  res
    .status(401)
    .send('<h1>Invalid login</h1><a href="/login">Try again</a>');
});

app.get("/logout", requireAuth, (req, res) => {
  destroySession(req, res);
  res.redirect("/login");
});

// ---------------- ROUTES: ROBLOX API ENTRY ----------------
app.post("/immigration-request", (req, res) => {
  const data = req.body || {};
  const id = requests.length === 0 ? 1 : requests[requests.length - 1].id + 1;

  data.id = id;
  data.serverReceivedAt = Date.now();
  data.status = "pending";

  requests.push(data);

  console.log("[IMMIGRATION] New request:", data.RobloxName, data.UserId);

  res.json({ ok: true, id });
});

// ---------------- DECISION (ACCEPT / DENY) ----------------
app.post("/request/decision", requireAuth, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  const decision = req.body.decision;

  const r = requests.find((x) => x.id === id);
  if (!r) {
    return res.status(404).send("Request not found");
  }

  if (decision === "accept") {
    r.status = "accepted";
    await rankRobloxUser(r.UserId, r.DesiredState);
  } else if (decision === "deny") {
    r.status = "denied";
  }

  res.redirect("/panel");
});

// ---------------- STATUS ENDPOINT (USED BY ROBLOX) ----------------
// GET /status?userId=123
app.get("/status", (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) {
    return res.status(400).json({ error: "Missing or invalid userId" });
  }

  // Find latest request for this user (by time/id)
  const userRequests = requests.filter(r => Number(r.UserId) === userId);
  if (userRequests.length === 0) {
    return res.json({ status: "none" });
  }

  const latest = userRequests.reduce((a, b) => {
    const ta = a.serverReceivedAt || a.TimeStamp || 0;
    const tb = b.serverReceivedAt || b.TimeStamp || 0;
    return ta >= tb ? a : b;
  });

  res.json({
    status: latest.status || "pending",
    lastId: latest.id,
    lastTime: latest.serverReceivedAt || latest.TimeStamp || null
  });
});

// ---------------- PANEL ----------------
app.get("/panel", requireAuth, (req, res) => {
  const blacklistArr = JSON.stringify(BLACKLISTED_GROUPS);
  const loggedInAs = req.session.username || "unknown";

  let html = `
  <html>
    <head>
      <title>Immigration Requests</title>
      <style>
        body { font-family: Arial, sans-serif; background:#050509; color:#eee; margin:0; }
        header { display:flex; justify-content:space-between; align-items:center; padding:16px 24px; background:#101018; border-bottom:1px solid #222; }
        header h1 { margin:0; font-size:22px; }
        header .right { font-size:13px; color:#aaa; }
        header a { color:#f06464; text-decoration:none; margin-left:12px; }
        .container { padding:20px; }
        .grid { display:flex; flex-wrap:wrap; gap:16px; }
        .card { background:#15151f; border-radius:10px; padding:14px; width:340px; box-shadow:0 0 15px rgba(0,0,0,0.4); display:flex; flex-direction:column; }
        .card-header { display:flex; gap:12px; align-items:center; margin-bottom:8px; }
        .avatar { width:64px; height:64px; border-radius:50%; background:#000; }
        .name { font-weight:bold; font-size:15px; }
        .meta { font-size:12px; color:#aaa; }
        .status-pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; margin-top:4px; }
        .status-pending { background:#444; color:#eee; }
        .status-accepted { background:#1f7a33; color:#e2ffe2; }
        .status-denied { background:#7a1f1f; color:#ffe2e2; }
        .section { margin-top:8px; font-size:13px; }
        .reason { white-space:pre-wrap; margin-top:4px; background:#101018; border-radius:6px; padding:6px; max-height:100px; overflow:auto; }
        .groups-list { margin-top:6px; max-height:140px; overflow:auto; }
        .group-row { display:flex; align-items:center; gap:6px; margin-bottom:4px; font-size:12px; }
        .group-icon { width:24px; height:24px; border-radius:4px; background:#000; flex-shrink:0; }
        .group-name { font-weight:bold; }
        .group-role { color:#bbb; }
        .group-badge { font-size:10px; padding:1px 6px; border-radius:999px; margin-left:4px; background:#444; }
        .group-badge.blacklisted { background:#c02424; color:#fff; }
        form.actions { margin-top:10px; display:flex; gap:8px; }
        form.actions button { flex:1; padding:6px 0; border:none; border-radius:4px; font-weight:bold; cursor:pointer; font-size:13px; }
        form.actions .accept { background:#2e8b57; color:#fff; }
        form.actions .accept:hover { background:#256e45; }
        form.actions .deny { background:#8b2e2e; color:#fff; }
        form.actions .deny:hover { background:#6d2424; }
        .empty { color:#888; font-size:14px; }
      </style>
    </head>
    <body>
      <header>
        <h1>Immigration Requests (${requests.length})</h1>
        <div class="right">
          Logged in as <b>${escapeHtml(loggedInAs)}</b>
          <a href="/logout">Logout</a>
        </div>
      </header>
      <div class="container">
  `;

  if (requests.length === 0) {
    html += `<p class="empty">No requests yet. Once players file immigration forms in-game, they'll appear here.</p>`;
  } } else {
  // Oldest first (by serverReceivedAt or id)
  const sorted = [...requests].sort((a, b) => {
    const ta = a.serverReceivedAt || a.TimeStamp || 0;
    const tb = b.serverReceivedAt || b.TimeStamp || 0;
    return ta - tb;
  });

  html += `<div class="grid">`;

  for (const r of sorted) {
    const statusClass =
      r.status === "accepted"
        ? "status-accepted"
        : r.status === "denied"
        ? "status-denied"
        : "status-pending";

    html += `
      <div class="card" data-user-id="${r.UserId}" data-request-id="${r.id}">
        ...
    `;
  }

  html += `</div>`;
})</div>
              <div class="meta">UserId: ${r.UserId}</div>
              <div class="meta roblox-age">Roblox age: loading...</div>
              <div class="status-pill ${statusClass}">${r.status}</div>
            </div>
          </div>
          <div class="section">
            <b>Desired State:</b> ${escapeHtml(r.DesiredState || "")}
          </div>
          <div class="section">
            <b>Reason:</b>
            <div class="reason">${escapeHtml(r.Reason || "")}</div>
          </div>
          <div class="section">
            <b>Extra Info:</b>
            <div class="reason">${escapeHtml(r.ExtraInfo || "")}</div>
          </div>
          <div class="section groups">
            <b>Groups:</b>
            <div class="groups-list">Loading...</div>
          </div>
          <form class="actions" method="POST" action="/request/decision">
            <input type="hidden" name="id" value="${r.id}" />
            <button type="submit" name="decision" value="accept" class="accept">Accept</button>
            <button type="submit" name="decision" value="deny" class="deny">Deny</button>
          </form>
        </div>
      `;
    }

    html += `</div>`;
  }

  html += `
      </div>
      <script>
        const BLACKLISTED_GROUP_IDS = ${blacklistArr};

        function setAvatar(card, userId) {
          const img = card.querySelector(".avatar");
          img.src = "https://www.roblox.com/headshot-thumbnail/image?userId=" + userId + "&width=150&height=150&format=png";
        }

        async function loadProfile(card, userId) {
          try {
            const ageEl = card.querySelector(".roblox-age");
            const res = await fetch("https://users.roblox.com/v1/users/" + userId);
            if (!res.ok) throw new Error("profile error");
            const data = await res.json();
            const created = new Date(data.created);
            const now = new Date();
            const ageDays = Math.floor((now - created) / (1000*60*60*24));
            ageEl.textContent = "Roblox age: " + ageDays + " days (" + created.toLocaleDateString() + ")";
          } catch (e) {
            console.error(e);
          }
        }

        async function loadGroups(card, userId) {
          const container = card.querySelector(".groups-list");
          try {
            const res = await fetch("https://groups.roblox.com/v2/users/" + userId + "/groups/roles");
            if (!res.ok) throw new Error("groups error");
            const json = await res.json();
            const groups = json.data || [];

            if (groups.length === 0) {
              container.textContent = "No groups.";
              return;
            }

            container.innerHTML = "";
            for (const g of groups) {
              const groupId = g.group.id;
              const row = document.createElement("div");
              row.className = "group-row";

              const icon = document.createElement("img");
              icon.className = "group-icon";
              icon.src = "https://thumbnails.roblox.com/v1/groups/icons?groupIds=" + groupId + "&size=150x150&format=Png&isCircular=false";

              const textWrap = document.createElement("div");
              const nameSpan = document.createElement("span");
              nameSpan.className = "group-name";
              nameSpan.textContent = g.group.name;

              const roleSpan = document.createElement("span");
              roleSpan.className = "group-role";
              roleSpan.textContent = " — " + g.role.name;

              textWrap.appendChild(nameSpan);
              textWrap.appendChild(roleSpan);

              const isBlacklisted = BLACKLISTED_GROUP_IDS.includes(groupId);
              if (isBlacklisted) {
                const badge = document.createElement("span");
                badge.className = "group-badge blacklisted";
                badge.textContent = "BLACKLISTED";
                textWrap.appendChild(badge);
              }

              row.appendChild(icon);
              row.appendChild(textWrap);
              container.appendChild(row);
            }
          } catch (e) {
            console.error(e);
            container.textContent = "Failed to load groups.";
          }
        }

        function init() {
          const cards = document.querySelectorAll(".card[data-user-id]");
          cards.forEach(card => {
            const userId = card.getAttribute("data-user-id");
            setAvatar(card, userId);
            loadProfile(card, userId);
            loadGroups(card, userId);
          });
        }

        window.addEventListener("load", init);
      </script>
    </body>
  </html>
  `;

  res.send(html);
});

// ---------------- ROOT ----------------
app.get("/", (req, res) => {
  res.redirect("/panel");
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log("DC Immigration API running on port " + PORT);
});

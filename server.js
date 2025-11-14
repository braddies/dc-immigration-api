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
// ADMIN_ACCOUNTS (env) = JSON string like:
// [
//   {"username":"RuckF0rce","password":"FloridaBoy8211#"},
//   {"username":"officer1","password":"OtherPass"}
// ]
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
// BLACKLISTED_GROUPS (env) = "123456,789012"
const BLACKLISTED_GROUPS = (process.env.BLACKLISTED_GROUPS || "")
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((n) => !Number.isNaN(n));

// ---------------- ROBLOX RANKING CONFIG ----------------
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";
const IMMIGRATION_GROUP_ID = parseInt(
  process.env.IMMIGRATION_GROUP_ID || "0",
  10
);
const IMMIGRATION_ROLE_ID = parseInt(
  process.env.IMMIGRATION_ROLE_ID || "0",
  10
);

// rank to this when request is denied
const DENIED_ROLE_ID = 235;

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
    console.log(`[ROBLOX] Logged in as ${user.name} (ID: ${user.id})`);
  } catch (e) {
    console.error("[ROBLOX] Failed to log in with cookie:", e);
  }
}
initRoblox(); // fire and forget

// ---------------- RANKING FUNCTION ----------------
async function rankRobloxUser(userId, desiredState, outcome) {
  if (!ROBLOX_COOKIE || !IMMIGRATION_GROUP_ID) {
    console.warn(
      "[RANKING] Missing ROBLOX_COOKIE / IMMIGRATION_GROUP_ID; skipping rank."
    );
    return;
  }

  let roleId;
  if (outcome === "accepted") {
    roleId = IMMIGRATION_ROLE_ID;
  } else if (outcome === "denied") {
    roleId = DENIED_ROLE_ID;
  } else {
    console.warn("[RANKING] Unknown outcome:", outcome);
    return;
  }

  try {
    await noblox.setRank(IMMIGRATION_GROUP_ID, Number(userId), roleId);
    console.log(
      `[RANKING] Ranked user ${userId} to rank ${roleId} in group ${IMMIGRATION_GROUP_ID} (state="${desiredState}", outcome="${outcome}")`
    );
  } catch (e) {
    console.error("[RANKING] Failed to rank user:", userId, e);
  }
}

// ---------------- LOGIN ROUTES ----------------
app.get("/login", (req, res) => {
  const html = `
  <html>
    <head>
      <title>DC Immigration Login</title>
      <style>
        body { font-family: Arial, sans-serif; background:#0b0b0f; color:#eee;
               display:flex; justify-content:center; align-items:center;
               height:100vh; margin:0; }
        .card { background:#15151b; padding:30px; border-radius:8px;
                width:320px; box-shadow:0 0 20px rgba(0,0,0,0.6); }
        h1 { margin-top:0; font-size:22px; }
        label { display:block; margin-top:10px; font-size:14px; }
        input[type=text], input[type=password] {
          width:100%; padding:8px; margin-top:4px; border-radius:4px;
          border:1px solid #333; background:#1f1f27; color:#eee;
        }
        button { margin-top:15px; width:100%; padding:10px; border:none;
                 border-radius:4px; background:#3478f6; color:white;
                 font-weight:bold; cursor:pointer; }
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

  res.status(401).send('<h1>Invalid login</h1><a href="/login">Try again</a>');
});

app.get("/logout", requireAuth, (req, res) => {
  destroySession(req, res);
  res.redirect("/login");
});

// ---------------- ROUTES: ROBLOX API ENTRY (FROM GAME) ----------------
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

// ---------------- STATUS ENDPOINT (USED BY ROBLOX) ----------------
// GET /status?userId=123
app.get("/status", (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) {
    return res.status(400).json({ error: "Missing or invalid userId" });
  }

  const userRequests = requests.filter((r) => Number(r.UserId) === userId);
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
    lastTime: latest.serverReceivedAt || latest.TimeStamp || null,
  });
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
    await rankRobloxUser(r.UserId, r.DesiredState, "accepted");
  } else if (decision === "deny") {
    r.status = "denied";
    await rankRobloxUser(r.UserId, r.DesiredState, "denied");
  }

  res.redirect("/panel");
});

// ---------------- PROXY ROUTES (AVOID CORS) ----------------
// Node 22 has global fetch, so no extra dependency.
async function proxyJson(res, url) {
  try {
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("[PROXY] Failed for", url, e);
    res.status(500).json({ error: "proxy_failed" });
  }
}

app.get("/proxy/user/:userId", (req, res) => {
  const { userId } = req.params;
  proxyJson(res, `https://users.roblox.com/v1/users/${userId}`);
});

app.get("/proxy/groupIcon/:groupId", (req, res) => {
  const { groupId } = req.params;
  proxyJson(
    res,
    `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupId}&size=420x420&format=Png&isCircular=false`
  );
});

app.get("/proxy/friends/:userId", (req, res) => {
  const { userId } = req.params;
  proxyJson(res, `https://friends.roblox.com/v1/users/${userId}/friends/count`);
});

app.get("/proxy/favorites/:userId", (req, res) => {
  const { userId } = req.params;
  proxyJson(
    res,
    `https://games.roblox.com/v1/users/${userId}/favorite/games?limit=10`
  );
});

app.get("/proxy/badges/:userId", (req, res) => {
  const { userId } = req.params;
  proxyJson(
    res,
    `https://badges.roblox.com/v1/users/${userId}/badges?limit=10`
  );
});

app.get("/proxy/groups/:userId", (req, res) => {
  const { userId } = req.params;
  proxyJson(
    res,
    `https://groups.roblox.com/v1/users/${userId}/groups/roles`
  );
});

// ---------------- PANEL (ALT DETECTION + GROUPS) ----------------
app.get("/panel", requireAuth, (req, res) => {
  const loggedInAs = req.session.username || "unknown";
  const blacklistArr = JSON.stringify(BLACKLISTED_GROUPS);

  let html = `
  <html>
    <head>
      <title>Immigration Requests</title>
      <style>
        body { font-family: Arial, sans-serif; background:#050509; color:#eee; margin:0; }
        header { display:flex; justify-content:space-between; align-items:center;
                 padding:16px 24px; background:#101018; border-bottom:1px solid #222; }
        header h1 { margin:0; font-size:22px; }
        header .right { font-size:13px; color:#aaa; }
        header a { color:#f06464; text-decoration:none; margin-left:12px; }

        .container { padding:20px; }
        .grid { display:flex; flex-wrap:wrap; gap:16px; }
        .card { background:#15151f; border-radius:10px; padding:14px;
                width:420px; box-shadow:0 0 15px rgba(0,0,0,0.4); }

        .card-header { display:flex; gap:12px; align-items:center; }
        .avatar { width:64px; height:64px; border-radius:50%; object-fit:cover; }

        .name { font-weight:bold; font-size:16px; }
        .meta { font-size:12px; color:#aaa; }

        .status-pill {
          display:inline-block; padding:4px 10px; border-radius:8px;
          font-size:12px; margin-top:6px;
        }
        .status-pending { background:#444; }
        .status-accepted { background:#1f7a33; }
        .status-denied { background:#7a1f1f; }

        .alt-status { font-size:16px; margin-top:10px; font-weight:bold; }
        .alt-good { color:#3bd45a; }
        .alt-medium { color:#d4c83b; }
        .alt-bad { color:#e84d4d; }

        .section { margin-top:12px; }
        .section b { display:block; margin-bottom:4px; }

        .groups-list { max-height:180px; overflow:auto; padding-right:4px; }
        .group-row { display:flex; align-items:center; gap:8px; font-size:12px; margin-bottom:4px; }
        .group-icon { width:24px; height:24px; border-radius:4px; background:#000; flex-shrink:0; }
        .group-text { display:flex; flex-direction:column; }
        .group-name { font-weight:bold; }
        .group-role { color:#bbb; }
        .group-row.blacklisted { color:#ff6b6b; }

        form.actions { margin-top:14px; display:flex; gap:10px; }
        form.actions button {
          flex:1; padding:8px 0; border:none; border-radius:5px;
          font-size:14px; font-weight:bold; cursor:pointer;
        }
        .accept { background:#2e8b57; color:#fff; }
        .deny { background:#8b2e2e; color:#fff; }
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
    html += `<p>No immigration requests yet.</p>`;
  } else {
    const sorted = [...requests].sort(
      (a, b) => (a.serverReceivedAt || 0) - (b.serverReceivedAt || 0)
    );

    html += `<div class="grid">`;

    for (const r of sorted) {
      html += `
      <div class="card" data-user-id="${r.UserId}">
        <div class="card-header">
          <img class="avatar" src="" />
          <div>
            <div class="name">${escapeHtml(r.RobloxName)}</div>
            <div class="meta">UserId: ${r.UserId}</div>
            <div class="meta roblox-age">Account age: loading...</div>
            <div class="status-pill status-${r.status}">${r.status}</div>
          </div>
        </div>

        <div class="alt-status alt-loading">Alt Status: Loading...</div>

        <div class="section">
          <b>Groups</b>
          <div class="groups-list">Loading groups...</div>
        </div>

        <form class="actions" method="POST" action="/request/decision">
          <input type="hidden" name="id" value="${r.id}" />
          <button type="submit" name="decision" value="accept" class="accept">Accept</button>
          <button type="submit" name="decision" value="deny" class="deny">Deny</button>
        </form>
      </div>`;
    }

    html += `</div>`;
  }

  html += `
      </div>

<script>
  const BLACKLISTED_GROUP_IDS = ${blacklistArr};

  // ---- ALT CHECK + AGE ----
  async function evaluateAltAndAge(card, userId) {
    let score = 0;

    // Account age
    try {
      const res = await fetch("/proxy/user/" + userId);
      const data = await res.json();
      const created = new Date(data.created);
      const ageDays = Math.floor((Date.now() - created.getTime()) / 86400000);

      const ageEl = card.querySelector(".roblox-age");
      ageEl.textContent = "Account age: " +
        ageDays.toLocaleString() + " days (" +
        created.toLocaleDateString() + ")";

      if (ageDays < 7) score += 5;
      else if (ageDays < 30) score += 3;
      else if (ageDays < 90) score += 1;
    } catch (e) {
      console.error(e);
      card.querySelector(".roblox-age").textContent = "Account age: failed";
    }

    // Friends
    try {
      const res = await fetch("/proxy/friends/" + userId);
      const data = await res.json();
      const friendCount = data.count || 0;
      if (friendCount === 0) score += 3;
      else if (friendCount <= 3) score += 1;
    } catch (e) {
      console.error(e);
    }

    // Favorites
    try {
      const res = await fetch("/proxy/favorites/" + userId);
      const data = await res.json();
      const favCount = (data.data || []).length;
      if (favCount === 0) score += 1;
    } catch (e) {
      console.error(e);
    }

    // Badges
    try {
      const res = await fetch("/proxy/badges/" + userId);
      const data = await res.json();
      const badgeCount = (data.data || []).length;
      if (badgeCount === 0) score += 1;
    } catch (e) {
      console.error(e);
    }

    // Groups (for scoring only; actual list done separately)
    try {
      const res = await fetch("/proxy/groups/" + userId);
      const data = await res.json();
      const groupCount = (data.data || []).length;
      if (groupCount < 3) score += 1;
    } catch (e) {
      console.error(e);
    }

    // Final verdict
    let verdict = "";
    let cssClass = "";
    if (score <= 2) { verdict = "Not an Alt"; cssClass = "alt-good"; }
    else if (score <= 5) { verdict = "Possibly an Alt"; cssClass = "alt-medium"; }
    else { verdict = "Definitely an Alt"; cssClass = "alt-bad"; }

    const altBox = card.querySelector(".alt-status");
    altBox.textContent = "Alt Status: " + verdict;
    altBox.classList.remove("alt-loading");
    altBox.classList.add(cssClass);
  }

  // ---- GROUP LIST ----
  async function loadGroups(card, userId) {
  const container = card.querySelector(".groups-list");
  try {
    const res = await fetch("/proxy/groups/" + userId);
    const data = await res.json();
    const groups = data.data || [];

    if (groups.length === 0) {
      container.textContent = "No groups.";
      return;
    }

    container.innerHTML = "";
    for (const g of groups) {
      const groupId = g.group.id;
      const row = document.createElement("div");
      row.className = "group-row";

      // --- get icon URL via proxy -> thumbnails API ---
      let iconUrl = "";
      try {
        const iconRes = await fetch("/proxy/groupIcon/" + groupId);
        const iconJson = await iconRes.json();
        if (iconJson.data && iconJson.data[0] && iconJson.data[0].imageUrl) {
          iconUrl = iconJson.data[0].imageUrl;
        }
      } catch (e) {
        console.error("[GROUP ICON]", e);
      }

      const icon = document.createElement("img");
      icon.className = "group-icon";
      if (iconUrl) {
        icon.src = iconUrl;
      }

      const textWrap = document.createElement("div");
      textWrap.className = "group-text";

      const nameSpan = document.createElement("span");
      nameSpan.className = "group-name";
      nameSpan.textContent = g.group.name;

      const roleSpan = document.createElement("span");
      roleSpan.className = "group-role";
      roleSpan.textContent = "Role: " + g.role.name;

      textWrap.appendChild(nameSpan);
      textWrap.appendChild(roleSpan);

      if (BLACKLISTED_GROUP_IDS.includes(groupId)) {
        row.classList.add("blacklisted");
        const tag = document.createElement("span");
        tag.textContent = "BLACKLISTED";
        tag.style.fontSize = "10px";
        tag.style.fontWeight = "bold";
        tag.style.marginLeft = "4px";
        tag.style.padding = "1px 6px";
        tag.style.borderRadius = "999px";
        tag.style.background = "#c02424";
        tag.style.color = "#fff";
        textWrap.appendChild(tag);
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

  // ---- INIT ----
  function init() {
    const cards = document.querySelectorAll(".card[data-user-id]");
    cards.forEach(card => {
      const userId = card.getAttribute("data-user-id");

      // avatar
      card.querySelector(".avatar").src =
        "https://api.newstargeted.com/roblox/users/v1/avatar-headshot?userid=" +
        userId;

      evaluateAltAndAge(card, userId);
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

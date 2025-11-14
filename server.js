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
const sessions = new Map();          // token -> { created, username }
const comments = new Map();          // userId -> { text, updatedBy, updatedAt }

// Elections + Parties (in-memory only)
const elections = new Map();         // key -> election object
const parties = [];                  // { id, name }
let nextPartyId = 1;

// ---------------- AUTH CONFIG ----------------
// ADMIN_ACCOUNTS (env) = JSON string like:
// [
//   {"username":"admin","password":"SuperSecret"},
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

// ---------------- ROBLOX CONFIG ----------------
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";
const IMMIGRATION_GROUP_ID = parseInt(
  process.env.IMMIGRATION_GROUP_ID || "0",
  10
);
// Treat these as *rank numbers* (0–255)
const IMMIGRATION_RANK = parseInt(
  process.env.IMMIGRATION_ROLE_ID || "0",
  10
);
// Failed Immigration rank (change if different in your group)
const DENIED_ROLE_ID = 235;

// cache roles -> rolesetIds
let cachedRoles = null;

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
    console.warn("[ROBLOX] ROBLOX_COOKIE not set; ranking and member fetch will be disabled.");
    return;
  }
  try {
    const user = await noblox.setCookie(ROBLOX_COOKIE);
    console.log(`[ROBLOX] Logged in as ${user.name} (ID: ${user.id})`);
  } catch (e) {
    console.error("[ROBLOX] Failed to log in with cookie:", e);
  }
}
initRoblox();

// ---------------- ROLE / MEMBER HELPERS ----------------

// Get and cache all roles for the immigration group
async function getGroupRoles() {
  if (!IMMIGRATION_GROUP_ID) return [];
  if (!cachedRoles) {
    try {
      cachedRoles = await noblox.getRoles(IMMIGRATION_GROUP_ID);
      console.log("[ROLES] Loaded roles for group", IMMIGRATION_GROUP_ID);
    } catch (e) {
      console.error("[ROLES] Failed to load roles:", e);
      cachedRoles = [];
    }
  }
  return cachedRoles;
}

// Convert a rank number -> rolesetId for use with getPlayers
async function getRoleSetIdFromRank(rank) {
  const roles = await getGroupRoles();
  const role = roles.find((r) => r.rank === rank);
  if (!role) {
    console.warn(
      `[ROLES] No role found in group ${IMMIGRATION_GROUP_ID} with rank ${rank}`
    );
    return null;
  }
  return role.id;
}

// Fetch all members in a given rank (by rolesetId)
async function getMembersInRank(rank) {
  if (!IMMIGRATION_GROUP_ID || !ROBLOX_COOKIE) return [];
  const rolesetId = await getRoleSetIdFromRank(rank);
  if (!rolesetId) return [];

  try {
    const players = await noblox.getPlayers(
      IMMIGRATION_GROUP_ID,
      rolesetId,
      "Asc",
      -1
    );
    console.log(
      `[GROUP] Got ${players.length} members for rank ${rank} (rolesetId ${rolesetId})`
    );
    return players; // GroupUser[]
  } catch (e) {
    console.error("[GROUP] Failed to get players for rank", rank, e);
    return [];
  }
}

// ---------------- RANKING FUNCTION ----------------
async function rankRobloxUser(userId, outcome) {
  if (!ROBLOX_COOKIE || !IMMIGRATION_GROUP_ID) {
    console.warn(
      "[RANKING] Missing ROBLOX_COOKIE / IMMIGRATION_GROUP_ID; skipping rank."
    );
    return;
  }

  let targetRank;
  if (outcome === "accepted") {
    targetRank = IMMIGRATION_RANK;
  } else if (outcome === "denied") {
    targetRank = DENIED_ROLE_ID;
  } else {
    console.warn("[RANKING] Unknown outcome:", outcome);
    return;
  }

  try {
    await noblox.setRank(IMMIGRATION_GROUP_ID, Number(userId), targetRank);
    console.log(
      `[RANKING] Ranked user ${userId} to rank ${targetRank} in group ${IMMIGRATION_GROUP_ID} (outcome="${outcome}")`
    );
  } catch (e) {
    console.error("[RANKING] Failed to rank user:", userId, e);
  }
}

// ---------------- ELECTIONS DATA ----------------
function initElections() {
  if (elections.size > 0) return;

  function base(key, name) {
    return {
      key,
      name,
      enabled: false,
      registrationEnd: null,   // timestamp ms
      electionEnd: null,       // timestamp ms
      requiredSignatures: 0,
      electionStarted: false,
      resultsFinalized: false,
      registrations: [],       // future: { userId, username, displayName, signatures, partyId, onBallot }
      votes: []                // future: { voterUserId, candidateUserId, timestamp }
    };
  }

  elections.set("presidential", base("presidential", "Presidential Elections"));
  elections.set("senate", base("senate", "Senate Elections"));
  elections.set("house", base("house", "House Elections"));
  elections.set("mayor", base("mayor", "Mayor Elections"));
  elections.set("custom1", base("custom1", "Custom Election"));
}
initElections();

function getElectionPhase(e, nowMs = Date.now()) {
  if (!e.enabled) return "Disabled";
  if (!e.registrationEnd || !e.electionEnd) return "Setup";

  const regEnd = e.registrationEnd;
  const elEnd = e.electionEnd;

  if (nowMs < regEnd) return "Registration";
  if (!e.electionStarted) return "Filtering (Registrations)";
  if (nowMs < elEnd) return "Voting";
  if (!e.resultsFinalized) return "Filtering (Results)";
  return "Completed";
}

// ---------------- LOGIN ROUTES ----------------
app.get("/login", (req, res) => {
  const html = `
  <html>
    <head>
      <title>DC Control Panel Login</title>
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

// ---------------- PROXY ROUTES (ALT & GROUP ICONS) ----------------
// Use Node's global fetch to dodge CORS from the browser.
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
  proxyJson(res, `https://users.roblox.com/v1/users/${req.params.userId}`);
});

app.get("/proxy/groupIcon/:groupId", (req, res) => {
  proxyJson(
    res,
    `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${req.params.groupId}&size=420x420&format=Png&isCircular=false`
  );
});

app.get("/proxy/friends/:userId", (req, res) => {
  proxyJson(
    res,
    `https://friends.roblox.com/v1/users/${req.params.userId}/friends/count`
  );
});

app.get("/proxy/favorites/:userId", (req, res) => {
  proxyJson(
    res,
    `https://games.roblox.com/v1/users/${req.params.userId}/favorite/games?limit=10`
  );
});

app.get("/proxy/badges/:userId", (req, res) => {
  proxyJson(
    res,
    `https://badges.roblox.com/v1/users/${req.params.userId}/badges?limit=10`
  );
});

app.get("/proxy/groups/:userId", (req, res) => {
  proxyJson(
    res,
    `https://groups.roblox.com/v1/users/${req.params.userId}/groups/roles`
  );
});

// ---------------- DECISION (ACCEPT / DENY + COMMENT) ----------------
app.post("/decision", requireAuth, async (req, res) => {
  const { userId, decision, comment } = req.body || {};
  if (!userId || !decision) {
    return res.status(400).send("Missing userId or decision");
  }

  // store / update comment (in-memory only)
  const trimmed = (comment || "").trim();
  if (trimmed.length > 0) {
    comments.set(String(userId), {
      text: trimmed,
      updatedBy: req.session.username || "unknown",
      updatedAt: Date.now(),
    });
  }

  if (decision === "accept") {
    await rankRobloxUser(userId, "accepted");
  } else if (decision === "deny") {
    await rankRobloxUser(userId, "denied");
  }

  res.redirect("/panel");
});

// ---------------- ELECTIONS ROUTES (SERVER STATE) ----------------
app.post("/elections/toggle", requireAuth, (req, res) => {
  const { key, enabled } = req.body || {};
  const e = elections.get(key);
  if (!e) return res.status(404).send("Unknown election key");
  e.enabled = enabled === "1";
  res.redirect("/elections");
});

app.post("/elections/update", requireAuth, (req, res) => {
  const { key, registrationEnd, electionEnd, requiredSignatures, name } =
    req.body || {};
  const e = elections.get(key);
  if (!e) return res.status(404).send("Unknown election key");

  if (registrationEnd) {
    e.registrationEnd = Date.parse(registrationEnd);
  } else {
    e.registrationEnd = null;
  }

  if (electionEnd) {
    e.electionEnd = Date.parse(electionEnd);
  } else {
    e.electionEnd = null;
  }

  e.requiredSignatures = parseInt(requiredSignatures || "0", 10) || 0;

  // allow renaming custom election
  if (key === "custom1" && name && name.trim().length > 0) {
    e.name = name.trim();
  }

  res.redirect("/elections");
});

app.post("/elections/begin", requireAuth, (req, res) => {
  const { key } = req.body || {};
  const e = elections.get(key);
  if (!e) return res.status(404).send("Unknown election key");
  e.electionStarted = true;
  res.redirect("/elections");
});

app.post("/elections/finalize", requireAuth, (req, res) => {
  const { key } = req.body || {};
  const e = elections.get(key);
  if (!e) return res.status(404).send("Unknown election key");
  e.resultsFinalized = true;
  res.redirect("/elections");
});

// Parties
app.post("/elections/party/add", requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.redirect("/elections");
  parties.push({
    id: nextPartyId++,
    name: name.trim(),
  });
  res.redirect("/elections");
});

app.post("/elections/party/delete", requireAuth, (req, res) => {
  const { id } = req.body || {};
  const pid = parseInt(id || "0", 10);
  const idx = parties.findIndex((p) => p.id === pid);
  if (idx !== -1) parties.splice(idx, 1);
  res.redirect("/elections");
});

// ---------------- PANEL (IMMIGRATION OFFICE + FAILED) ----------------
app.get("/panel", requireAuth, async (req, res) => {
  const loggedInAs = req.session.username || "unknown";
  const blacklistArr = JSON.stringify(BLACKLISTED_GROUPS);

  const pendingMembers = await getMembersInRank(IMMIGRATION_RANK);
  const failedMembers = await getMembersInRank(DENIED_ROLE_ID);
  const totalCount = pendingMembers.length + failedMembers.length;

  let html = `
  <html>
    <head>
      <title>Immigration Panel</title>
      <style>
        body { font-family: Arial, sans-serif; background:#050509; color:#eee; margin:0; }

        header { display:flex; justify-content:space-between; align-items:center;
                 padding:12px 20px; background:#101018; border-bottom:1px solid #222; position:relative; }
        .header-left { display:flex; align-items:center; gap:10px; }
        .logo { font-weight:bold; font-size:18px; }
        .hamburger {
          width:32px; height:32px; border-radius:999px;
          border:1px solid #333; background:#181824; color:#eee;
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; font-size:18px;
        }
        .hamburger:hover { background:#242437; }

        .nav-links { display:flex; gap:8px; }
        .nav-link {
          color:#ccc; text-decoration:none; font-size:13px;
          padding:6px 12px; border-radius:999px;
        }
        .nav-link:hover { background:#1e1e2b; color:#fff; }
        .nav-link.active { background:#3478f6; color:#fff; }

        header .right { font-size:13px; color:#aaa; display:flex; align-items:center; gap:12px; }
        header a { color:#f06464; text-decoration:none; }

        .refresh-btn {
          border:none; border-radius:999px; padding:6px 12px;
          background:#2e2e3a; color:#eee; cursor:pointer; font-size:12px;
        }
        .refresh-btn:hover { background:#3d3d4a; }

        .container { padding:20px; }
        h2 { margin-top:24px; margin-bottom:8px; }
        .sub { color:#aaa; font-size:13px; margin-bottom:16px; }

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

        .comment-box { margin-top:10px; }
        .comment-box textarea {
          width:100%; min-height:48px; resize:vertical;
          background:#101018; color:#eee; border-radius:6px;
          border:1px solid #333; padding:6px; font-size:12px;
        }
        .comment-meta { font-size:11px; color:#888; margin-top:2px; }

        form.actions { margin-top:10px; display:flex; gap:10px; }
        form.actions button {
          flex:1; padding:8px 0; border:none; border-radius:5px;
          font-size:14px; font-weight:bold; cursor:pointer;
        }
        .accept { background:#2e8b57; color:#fff; }
        .deny { background:#8b2e2e; color:#fff; }

        @media (max-width: 720px) {
          .nav-links {
            position:absolute;
            left:0; right:0; top:52px;
            background:#101018;
            flex-direction:column;
            padding:8px 20px;
            display:none;
          }
          .nav-links.open { display:flex; }
        }
      </style>
    </head>
    <body>
      <header>
        <div class="header-left">
          <button class="hamburger" id="menuToggle">☰</button>
          <div class="logo">RUS Control</div>
          <nav class="nav-links" id="mainNav">
            <a href="/panel" class="nav-link active">Immigration</a>
            <a href="/elections" class="nav-link">Elections</a>
          </nav>
        </div>
        <div class="right">
          <button class="refresh-btn" id="refreshBtn">⟳ Refresh</button>
          <span>Logged in as <b>${escapeHtml(loggedInAs)}</b></span>
          <a href="/logout">Logout</a>
        </div>
      </header>

      <div class="container">
        <h2>Pending Immigration (Immigration Office)</h2>
        <div class="sub">Members currently in the Immigration Office rank.</div>
  `;

  // ------- Pending Immigration grid -------
  if (pendingMembers.length === 0) {
    html += `<p>No pending immigration members in Immigration Office rank.</p>`;
  } else {
    html += `<div class="grid">`;
    for (const m of pendingMembers) {
      const user = m.user || m; // GroupUser has .user; some older versions may not
      const userId = user.userId || user.id;
      const username = user.username || user.name || "Unknown";
      const commentInfo = comments.get(String(userId));
      const commentText = commentInfo ? commentInfo.text : "";
      const commentMeta = commentInfo
        ? `Last note by ${escapeHtml(commentInfo.updatedBy)} at ${new Date(
            commentInfo.updatedAt
          ).toLocaleString()}`
        : "No notes yet.";

      html += `
        <div class="card" data-user-id="${userId}">
          <div class="card-header">
            <img class="avatar" src="" />
            <div>
              <div class="name">${escapeHtml(username)}</div>
              <div class="meta">UserId: ${userId}</div>
              <div class="meta roblox-age">Account age: loading...</div>
              <div class="status-pill status-pending">pending</div>
            </div>
          </div>

          <div class="alt-status alt-loading">Alt Status: Loading...</div>

          <div class="section">
            <b>Groups</b>
            <div class="groups-list">Loading groups...</div>
          </div>

          <div class="comment-box">
            <textarea name="comment" form="decision-${userId}" placeholder="Add a staff note (reason, context, etc.)">${escapeHtml(
              commentText
            )}</textarea>
            <div class="comment-meta">${escapeHtml(commentMeta)}</div>
          </div>

          <form class="actions" id="decision-${userId}" method="POST" action="/decision">
            <input type="hidden" name="userId" value="${userId}" />
            <button type="submit" name="decision" value="accept" class="accept">Accept</button>
            <button type="submit" name="decision" value="deny" class="deny">Deny</button>
          </form>
        </div>
      `;
    }
    html += `</div>`;
  }

  // ------- Failed Immigration grid -------
  html += `
        <h2 style="margin-top:32px;">Failed Immigration</h2>
        <div class="sub">Members currently in the Failed Immigration rank.</div>
  `;

  if (failedMembers.length === 0) {
    html += `<p>No members in Failed Immigration rank.</p>`;
  } else {
    html += `<div class="grid">`;
    for (const m of failedMembers) {
      const user = m.user || m;
      const userId = user.userId || user.id;
      const username = user.username || user.name || "Unknown";
      const commentInfo = comments.get(String(userId));
      const commentText = commentInfo ? commentInfo.text : "";
      const commentMeta = commentInfo
        ? `Last note by ${escapeHtml(commentInfo.updatedBy)} at ${new Date(
            commentInfo.updatedAt
          ).toLocaleString()}`
        : "No notes yet.";

      html += `
        <div class="card" data-user-id="${userId}">
          <div class="card-header">
            <img class="avatar" src="" />
            <div>
              <div class="name">${escapeHtml(username)}</div>
              <div class="meta">UserId: ${userId}</div>
              <div class="meta roblox-age">Account age: loading...</div>
              <div class="status-pill status-denied">failed</div>
            </div>
          </div>

          <div class="alt-status alt-loading">Alt Status: Loading...</div>

          <div class="section">
            <b>Groups</b>
            <div class="groups-list">Loading groups...</div>
          </div>

          <div class="comment-box">
            <textarea name="comment" form="decision-${userId}" placeholder="Add or update staff note">${escapeHtml(
              commentText
            )}</textarea>
            <div class="comment-meta">${escapeHtml(commentMeta)}</div>
          </div>

          <form class="actions" id="decision-${userId}" method="POST" action="/decision">
            <input type="hidden" name="userId" value="${userId}" />
            <!-- No deny button here, they are already failed -->
            <button type="submit" name="decision" value="accept" class="accept">Move back to Immigration Office</button>
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

  document.getElementById("refreshBtn").addEventListener("click", () => {
    window.location.reload();
  });

  const menuToggle = document.getElementById("menuToggle");
  const mainNav = document.getElementById("mainNav");
  menuToggle.addEventListener("click", () => {
    mainNav.classList.toggle("open");
  });

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
      ageEl.textContent =
        "Account age: " +
        ageDays.toLocaleString() +
        " days (" +
        created.toLocaleDateString() +
        ")";

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

    // Groups (for alt scoring only)
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

  // ---- GROUP LIST + ICONS ----
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

        // Icon via proxy
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
        if (iconUrl) icon.src = iconUrl;

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
        "https://api.newstargeted.com/roblox/users/v1/avatar-headshot?userid=" + userId;

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

// ---------------- ELECTIONS PAGE ----------------
app.get("/elections", requireAuth, (req, res) => {
  const loggedInAs = req.session.username || "unknown";

  let html = `
  <html>
    <head>
      <title>Elections Management</title>
      <style>
        body { font-family: Arial, sans-serif; background:#050509; color:#eee; margin:0; }

        header { display:flex; justify-content:space-between; align-items:center;
                 padding:12px 20px; background:#101018; border-bottom:1px solid #222; position:relative; }
        .header-left { display:flex; align-items:center; gap:10px; }
        .logo { font-weight:bold; font-size:18px; }
        .hamburger {
          width:32px; height:32px; border-radius:999px;
          border:1px solid #333; background:#181824; color:#eee;
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; font-size:18px;
        }
        .hamburger:hover { background:#242437; }

        .nav-links { display:flex; gap:8px; }
        .nav-link {
          color:#ccc; text-decoration:none; font-size:13px;
          padding:6px 12px; border-radius:999px;
        }
        .nav-link:hover { background:#1e1e2b; color:#fff; }
        .nav-link.active { background:#3478f6; color:#fff; }

        header .right { font-size:13px; color:#aaa; display:flex; align-items:center; gap:12px; }
        header a { color:#f06464; text-decoration:none; }

        .container { padding:20px; }
        h2 { margin-top:24px; margin-bottom:8px; }
        .sub { color:#aaa; font-size:13px; margin-bottom:16px; }

        .election-grid { display:flex; flex-wrap:wrap; gap:16px; }
        .election-card {
          background:#15151f; border-radius:10px; padding:14px;
          width:420px; box-shadow:0 0 15px rgba(0,0,0,0.4);
        }

        .election-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
        .election-title { font-weight:bold; font-size:16px; }

        .pill { border-radius:999px; padding:4px 10px; font-size:11px; }
        .pill-on { background:#2e8b57; }
        .pill-off { background:#555; }
        .pill-phase { background:#222; }

        .field-row { display:flex; gap:8px; margin-top:8px; }
        .field { flex:1; display:flex; flex-direction:column; font-size:12px; }
        .field label { margin-bottom:2px; color:#aaa; }
        .field input[type="datetime-local"],
        .field input[type="number"],
        .field input[type="text"] {
          background:#101018; color:#eee; border-radius:4px; border:1px solid #333;
          padding:4px 6px; font-size:12px;
        }

        .small-btn {
          margin-top:8px; padding:6px 10px; border:none; border-radius:4px;
          background:#3478f6; color:#fff; font-size:12px; cursor:pointer;
        }
        .small-btn.secondary { background:#2e2e3a; }
        .small-btn.secondary:hover { background:#3d3d4a; }

        .section { margin-top:10px; font-size:13px; }
        .section b { display:block; margin-bottom:4px; }

        .meta { font-size:12px; color:#aaa; }

        .divider { margin:10px 0; border-top:1px solid #262633; }

        .list { font-size:12px; max-height:120px; overflow:auto; }
        .list-item { padding:2px 0; }

        /* Parties */
        .party-grid { display:flex; flex-wrap:wrap; gap:12px; margin-top:10px; }
        .party-card {
          background:#15151f; border-radius:8px; padding:8px 10px;
          font-size:13px; display:flex; justify-content:space-between; align-items:center;
        }
        .party-delete {
          border:none; border-radius:6px; padding:4px 8px;
          background:#7a1f1f; color:#fff; font-size:11px; cursor:pointer;
        }

        @media (max-width: 720px) {
          .nav-links {
            position:absolute;
            left:0; right:0; top:52px;
            background:#101018;
            flex-direction:column;
            padding:8px 20px;
            display:none;
          }
          .nav-links.open { display:flex; }
        }
      </style>
    </head>
    <body>
      <header>
        <div class="header-left">
          <button class="hamburger" id="menuToggle">☰</button>
          <div class="logo">RUS Control</div>
          <nav class="nav-links" id="mainNav">
            <a href="/panel" class="nav-link">Immigration</a>
            <a href="/elections" class="nav-link active">Elections</a>
          </nav>
        </div>
        <div class="right">
          <span>Logged in as <b>${escapeHtml(loggedInAs)}</b></span>
          <a href="/logout">Logout</a>
        </div>
      </header>

      <div class="container">
        <h2>Elections Management</h2>
        <div class="sub">Toggle elections on/off, set dates, and manage parties. All data is in-memory and resets when the server restarts.</div>

        <div class="election-grid">
  `;

  for (const e of elections.values()) {
    const phase = getElectionPhase(e);
    const enabled = e.enabled;
    const regVal = e.registrationEnd
      ? new Date(e.registrationEnd).toISOString().slice(0, 16)
      : "";
    const elVal = e.electionEnd
      ? new Date(e.electionEnd).toISOString().slice(0, 16)
      : "";
    const reqSig = e.requiredSignatures || 0;

    html += `
      <div class="election-card">
        <div class="election-header">
          <div class="election-title">${escapeHtml(e.name)}</div>
          <div>
            <span class="pill ${enabled ? "pill-on" : "pill-off"}">${enabled ? "On" : "Off"}</span>
            <span class="pill pill-phase">${escapeHtml(phase)}</span>
          </div>
        </div>

        <form method="POST" action="/elections/toggle">
          <input type="hidden" name="key" value="${e.key}" />
          <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}" />
          <button class="small-btn secondary" type="submit">
            ${enabled ? "Turn Off" : "Turn On"}
          </button>
        </form>

        <form method="POST" action="/elections/update">
          <input type="hidden" name="key" value="${e.key}" />
          <div class="field-row">
            <div class="field">
              <label>Registration End</label>
              <input type="datetime-local" name="registrationEnd" value="${regVal}" />
            </div>
            <div class="field">
              <label>Election End</label>
              <input type="datetime-local" name="electionEnd" value="${elVal}" />
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label>Required Signatures</label>
              <input type="number" min="0" name="requiredSignatures" value="${reqSig}" />
            </div>
            ${
              e.key === "custom1"
                ? `<div class="field">
                     <label>Custom Name</label>
                     <input type="text" name="name" value="${escapeHtml(e.name)}" />
                   </div>`
                : ""
            }
          </div>

          <button class="small-btn" type="submit">Save Settings</button>
        </form>

        <div class="section">
          <b>Phase & Info</b>
          <div class="meta">
            Current Phase: ${escapeHtml(phase)}<br/>
            Registration End: ${
              e.registrationEnd ? new Date(e.registrationEnd).toLocaleString() : "Not set"
            }<br/>
            Election End: ${
              e.electionEnd ? new Date(e.electionEnd).toLocaleString() : "Not set"
            }<br/>
            Signatures Required: ${reqSig}
          </div>
        </div>

        <div class="divider"></div>

        <div class="section">
          <b>Registrations</b>
          <div class="meta">${
            e.registrations.length === 0
              ? "No registrations yet (game integration will populate this)."
              : e.registrations.length + " tickets registered."
          }</div>
        </div>

        <div class="section">
          <b>Ballot Candidates</b>
          <div class="meta">
            ${
              e.registrations.filter(r => r.onBallot).length === 0
                ? "No candidates on the ballot yet."
                : "Candidates on ballot will appear here."
            }
          </div>
        </div>

        <div class="divider"></div>

        <div class="section">
          <b>Actions</b>
          ${
            phase === "Filtering (Registrations)"
              ? `<form method="POST" action="/elections/begin" style="display:inline;">
                   <input type="hidden" name="key" value="${e.key}" />
                   <button class="small-btn" type="submit">Begin Election</button>
                 </form>`
              : ""
          }
          ${
            phase === "Filtering (Results)"
              ? `<form method="POST" action="/elections/finalize" style="display:inline;">
                   <input type="hidden" name="key" value="${e.key}" />
                   <button class="small-btn secondary" type="submit">Finalize Results</button>
                 </form>`
              : ""
          }
          ${
            phase === "Completed"
              ? `<div class="meta" style="margin-top:4px;">Election completed. Future: show printable results here.</div>`
              : ""
          }
        </div>
      </div>
    `;
  }

  // Party management section
  html += `
        </div> <!-- election-grid -->

        <h2 style="margin-top:32px;">Party Management</h2>
        <div class="sub">Add or remove political parties. Assignment to candidates will use these IDs later.</div>

        <form method="POST" action="/elections/party/add" style="max-width:420px;">
          <div class="field-row">
            <div class="field">
              <label>Party Name</label>
              <input type="text" name="name" placeholder="Example: Liberal Party" />
            </div>
          </div>
          <button class="small-btn" type="submit">Add Party</button>
        </form>

        <div class="party-grid">
  `;

  if (parties.length === 0) {
    html += `<div class="meta" style="margin-top:8px;">No parties created yet.</div>`;
  } else {
    for (const p of parties) {
      html += `
          <div class="party-card">
            <span>#${p.id} — ${escapeHtml(p.name)}</span>
            <form method="POST" action="/elections/party/delete">
              <input type="hidden" name="id" value="${p.id}" />
              <button class="party-delete" type="submit">Remove</button>
            </form>
          </div>
      `;
    }
  }

  html += `
        </div> <!-- party-grid -->
      </div> <!-- container -->

<script>
  const menuToggle = document.getElementById("menuToggle");
  const mainNav = document.getElementById("mainNav");
  menuToggle.addEventListener("click", () => {
    mainNav.classList.toggle("open");
  });
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

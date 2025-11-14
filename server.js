const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Store requests in memory (you can switch to database later)
const requests = [];

app.post("/immigration-request", (req, res) => {
  const data = req.body || {};
  data.serverReceivedAt = Date.now();
  requests.push(data);

  console.log("[IMMIGRATION] New request:", data);
  res.json({ ok: true, message: "Request saved" });
});

app.get("/panel", (req, res) => {
  let html = `
    <html>
    <head><title>D.C. Immigration Requests</title></head>
    <body style="font-family:Arial;background:#111;color:#eee">
      <h1>Immigration Requests (${requests.length})</h1>
  `;

  for (const r of requests) {
    html += `
      <div style="border:1px solid #444;margin:10px;padding:10px;border-radius:6px">
        <b>${r.RobloxName} (${r.DisplayName})</b> — [${r.UserId}]<br>
        Desired State: <b>${r.DesiredState}</b><br>
        Reason:<br>
        <pre>${r.Reason}</pre>
        Extra:<br>
        <pre>${r.ExtraInfo}</pre>
        Submitted: ${new Date(r.TimeStamp * 1000).toLocaleString()}
      </div>
    `;
  }

  html += `</body></html>`;
  res.send(html);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

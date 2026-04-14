import express from "express";
import axios from "axios";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const LIST_FILE = "./listings.json";
let MANAGED_LISTINGS = [];
let LISTING_INFO = {};

if(fs.existsSync(LIST_FILE)) {
  MANAGED_LISTINGS = JSON.parse(fs.readFileSync(LIST_FILE,"utf8"));
} else {
  MANAGED_LISTINGS = [];
  fs.writeFileSync(LIST_FILE, JSON.stringify(MANAGED_LISTINGS));
}

function saveListings() {
  fs.writeFileSync(LIST_FILE, JSON.stringify(MANAGED_LISTINGS));
}

async function getGuestyNickname(listingId) {
  try {
    const resp = await axios.get(`https://open-api.guesty.com/v1/listings/${listingId}`, {
      headers: { Authorization: `Bearer ${process.env.GUESTY_API_TOKEN}` }
    });
    LISTING_INFO[listingId] = resp.data.nickname || resp.data.title || listingId;
    return LISTING_INFO[listingId];
  } catch {
    LISTING_INFO[listingId] = listingId;
    return listingId;
  }
}

async function getGuestyDays(listingId, startDate, endDate) {
  try {
    const resp = await axios.get(
      `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listing/${listingId}`,
      {
        headers: { Authorization: `Bearer ${process.env.GUESTY_API_TOKEN}` },
        params: {
          startDate,
          endDate,
          includeBlocks: true,
          includeReservations: true,
        }
      }
    );
    return Array.isArray(resp.data.days) ? resp.data.days : [];
  } catch {
    return [];
  }
}

// API: list, add, remove
app.get("/api/listings", (req,res) => res.json({listings: MANAGED_LISTINGS}));
app.post("/api/listings", async (req,res) => {
  const { id } = req.body;
  if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id))
    return res.status(400).json({ error: "Invalid or duplicate listing ID" });
  MANAGED_LISTINGS.push(id);
  saveListings();
  await getGuestyNickname(id);
  res.json({ listings: MANAGED_LISTINGS });
});
app.delete("/api/listings/:id", (req,res) => {
  const { id } = req.params;
  MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid !== id);
  saveListings();
  res.json({ listings: MANAGED_LISTINGS });
});
app.get("/api/nickname/:id", async (req, res) => {
  const { id } = req.params;
  const n = await getGuestyNickname(id);
  res.json({ nickname: n });
});

// Rate settings skeleton (expand for your needs)
app.get("/api/settings/:id", (req,res) => {
  res.json({settings: {minRate: "", maxRate: "", rules: []}});
});

app.post("/api/settings/:id", (req,res) => {
  res.json({ok:true});
});

// Calendar API (for 30 days, with real Guesty data)
app.post("/calendar-table", async (req,res) => {
  const { listingIds } = req.body;
  if (!listingIds||!Array.isArray(listingIds)||!listingIds.length) return res.send("<b>No properties to show.</b>");
  function pad2(v) {return v.toString().padStart(2,"0");}
  let start = new Date(), end = new Date(); end.setDate(start.getDate()+29);
  let dates=[], cursor=new Date(start);
  while (cursor<=end) {dates.push(cursor.toISOString().slice(0,10)); cursor.setDate(cursor.getDate()+1);}
  const rows = await Promise.all(listingIds.map(async (listingId) => {
    let nick = LISTING_INFO[listingId] || await getGuestyNickname(listingId);
    let days = await getGuestyDays(listingId, dates[0], dates[dates.length-1]);
    let daymap = {};
    for (const d of days) daymap[(d.date||d.day||d.calendarDate)] = d;
    return { listingId, nick, daymap };
  }));
  let tableHtml = `<div style="overflow-x:auto;max-width:100%"><div style="max-width:950px;overflow-x:auto">
  <div>Dates: ${dates[0]} to ${dates[dates.length-1]}</div>
  <div style="overflow-x:auto">
  <table style="min-width:1300px"><thead><tr>
  <th>Listing</th>
  ${dates.map(d=>`<th>${d.slice(5)}</th>`).join("")}
  </tr></thead><tbody>
  ${rows.map(row=>{
    return `<tr>
    <td><strong>${row.nick}</strong></td>
    ${dates.map(dt=>{
      const day = row.daymap[dt];
      const orig = (day?.price!=null ? "$"+day.price:"-");
      const minN = (day?.minNights!=null ? day.minNights : "-");
      return `<td>
        <div class="orig-rate">Original: ${orig}</div>
        <div class="price">Adjusted: -</div>
        <div class="minstay">Min nights: ${minN}</div>
      </td>`;
    }).join("")}
    </tr>`;
  }).join("")}
  </tbody></table></div></div></div>
  `;
  res.send(tableHtml);
});

// --- DASHBOARD UI ---

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Rental Dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', Arial, sans-serif; margin:0; background: #191a1d; color: #fff; }
    .layout { display: flex; min-height: 100vh; }
    nav#sidebar { background: #181a20; color:#fff; width: 225px; min-height: 100vh; padding-top: 36px; display: flex; flex-direction:column; align-items:center;}
    nav#sidebar h1 { font-size: 24px; font-weight:700; margin-bottom: 40px; }
    .nav-section { width:100%; }
    .nav-link { display:block; width:100%; color:#fff; text-decoration:none; padding:14px 34px; font-size:17px;
      border-left:5px solid transparent; transition: background 0.12s, border 0.12s; box-sizing:border-box;}
    .nav-link.active, .nav-link:hover { background: #23242a; border-color: #f90; }
    #main { flex:1; }
    .panel{background:#24252b; margin:44px auto; max-width:1050px; border-radius:14px; box-shadow:0 4px 18px #0004; padding:36px 32px;}
    h2 { font-size: 1.5rem; margin: 0 0 18px;}
    .input-row{display:flex;gap:10px;margin-bottom:18px;}
    input[type=text]{font-size:17px;padding:7px 12px;border:1.5px solid #444;border-radius:6px;background:#23242a;color:#fff;}
    button{background:#181a20;border:none;color:#fff;font-size:17px;font-weight:500;padding:7px 18px;border-radius:6px;cursor:pointer;}
    button.danger{background:#a32525;}
    .listing-list{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:18px;}
    .listing-pill{background:#23242a;border:1px solid #444;border-radius:8px;padding:8px 14px;display:flex;align-items:center;gap:10px;}
    #calendar-hold{margin-top:28px;}
    .calendar-scroll {overflow-x:auto; max-width:935px;}
    table{border-collapse:collapse;width:100%;background:#23242a;}
    th,td{border:1px solid #333;padding:8px 4px;text-align:center;}
    th{background:#23242a;font-weight:600;}
    .stat-block{background:#333;color:#a0a0a0;}
    .stat-booked{background:#f90;color:#23242a;}
    .orig-rate{color:#888;font-size:13px;}
    .minstay{font-size:13px;color:#ccd0d4;}
    .tab-bar{display:flex;gap:14px;margin-bottom:28px;}
    .tab-btn{background:#181a20;color:#fff;border:none;padding:10px 28px;font-size:17px;border-radius:8px;cursor:pointer;}
    .tab-btn.active, .tab-btn:hover{background:#23242a;}
  </style>
</head>
<body>
<div class="layout">
  <nav id="sidebar">
    <h1>Rental Dashboard</h1>
    <div class="nav-section">
      <a href="#" class="nav-link active" id="side-properties">PROPERTIES</a>
      <a href="#" class="nav-link" id="side-settings">RATE SETTINGS</a>
    </div>
  </nav>
  <div id="main"></div>
</div>
<script>
let state = {
  listings: [],
  listingsMap: {},
  selectedTab: "properties",
  settings: {}
};
async function fetchListings() {
  const r = await fetch('/api/listings');
  const j = await r.json();
  state.listings = j.listings;
  for (let id of state.listings) {
    if (!state.listingsMap[id]) {
      const rn = await fetch('/api/nickname/'+id); const n=await rn.json();
      state.listingsMap[id]={id, title:n.nickname};
    }
  }
}
async function addListing(id) {
  await fetch('/api/listings', {method:'POST', headers:{"Content-Type":"application/json"}, body:JSON.stringify({id})});
}
async function delListing(id) {
  await fetch('/api/listings/'+encodeURIComponent(id), {method:'DELETE'});
}
function showTabs() {
  document.getElementById("side-properties").classList.toggle("active", state.selectedTab==="properties");
  document.getElementById("side-settings").classList.toggle("active", state.selectedTab==="settings");
}
async function showProperties() {
  showTabs();
  let html = '<div class="panel"><h2>Properties</h2>';
  html += \`<form id="add-form" class="input-row">
    <input id="add-id" type="text" placeholder="Add new listing ID" required>
    <button type="submit">Add</button>
  </form>\`;
  if (!state.listings.length) {
    html += "<i>No listings.</i>";
  } else {
    html += '<div class="listing-list">';
    html += state.listings.map(id =>
      \`<span class="listing-pill">
        \${state.listingsMap[id]?.title||id}
        <button type="button" class="danger btnDel" data-id="\${id}">&times;</button>
      </span>\`
    ).join("");
    html += "</div>";
  }
  html += \`<div class="calendar-container" id="calendar-hold"></div></div>\`;
  document.getElementById("main").innerHTML = html;

  document.getElementById("add-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = document.getElementById("add-id").value.trim();
    if (v) {await addListing(v);await renderActiveTab();}
  };
  document.querySelectorAll('.btnDel').forEach(btn=>{
    btn.onclick = async ()=>{await delListing(btn.dataset.id);await renderActiveTab();}
  });

  if (state.listings.length) {
    fetch('/calendar-table',{
      method:'POST',
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({listingIds:state.listings})
    }).then(r=>r.text()).then(h=>{
      document.getElementById("calendar-hold").innerHTML=h;
    });
  }
}
async function showSettings() {
  showTabs();
  let html = '<div class="panel"><h2>Rate Settings</h2>';
  html += '<div>Coming soon! Here you will be able to edit your pricing automation rules.</div>';
  html += '</div>';
  document.getElementById("main").innerHTML = html;
}
async function renderActiveTab() {
  await fetchListings();
  if (state.selectedTab=="properties") showProperties();
  if (state.selectedTab=="settings") showSettings();
}
document.getElementById("side-properties").onclick=e=>{
  state.selectedTab="properties";renderActiveTab();
};
document.getElementById("side-settings").onclick=e=>{
  state.selectedTab="settings";renderActiveTab();
};
renderActiveTab();
</script>
</body>
</html>
`);
});

app.listen(PORT, ()=>console.log("Running on " + PORT));

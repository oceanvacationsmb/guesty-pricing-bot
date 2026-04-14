import express from "express";
import cors from "cors";
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
import fs from "fs";
const LIST_FILE = "./listings.json";
let MANAGED_LISTINGS = [];
if(fs.existsSync(LIST_FILE)) {
  MANAGED_LISTINGS = JSON.parse(fs.readFileSync(LIST_FILE,"utf8"));
} else {
  MANAGED_LISTINGS = [
    "69db18d8085e450014e2bf65",
    "69db12c790763a00130d40bc",
    "69db12bff579c50013548a0d"
  ];
  fs.writeFileSync(LIST_FILE, JSON.stringify(MANAGED_LISTINGS));
}

app.get("/api/listings", (req, res) =>
    res.json({ listings: MANAGED_LISTINGS })
);

app.post("/api/listings", (req, res) => {
    const { id } = req.body;
    if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id))
        return res.status(400).json({ error: "Invalid or duplicate listing ID" });
    MANAGED_LISTINGS.push(id);
  fs.writeFileSync(LIST_FILE, JSON.stringify(MANAGED_LISTINGS));
    res.json({ listings: MANAGED_LISTINGS });
});

app.delete("/api/listings/:id", (req, res) => {
    const { id } = req.params;
    MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid !== id);
    res.json({ listings: MANAGED_LISTINGS });
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
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
    table{border-collapse:collapse;width:100%;background:#23242a;}
    th,td{border:1px solid #333;padding:8px 4px;text-align:center;}
    th{background:#23242a;font-weight:600;}
    .stat-block{background:#333;color:#a0a0a0;}
    .stat-booked{background:#f90;color:#23242a;}
    .orig-rate{color:#888;font-size:13px;}
    .minstay{font-size:13px;color:#ccd0d4;}
  </style>
</head>
<body>
<div class="layout">
  <nav id="sidebar">
    <h1>Rental Dashboard</h1>
    <div class="nav-section">
      <a href="#" class="nav-link active" id="side-properties">PROPERTIES</a>
    </div>
  </nav>
  <div id="main"></div>
</div>
<script>
let state = {
  listings: [],
  listingsMap: {},
  selectedTab: "properties"
};
async function fetchListings() {
  const r = await fetch('/api/listings');
  const j = await r.json();
  state.listings = j.listings;
  for (let id of state.listings) {
    if (!state.listingsMap[id]) state.listingsMap[id]={id,title:id};
  }
}
async function addListing(id) {
  await fetch('/api/listings', {method:'POST', headers:{"Content-Type":"application/json"}, body:JSON.stringify({id})});
}
async function delListing(id) {
  await fetch('/api/listings/'+encodeURIComponent(id), {method:'DELETE'});
}
function showProperties() {
  setSidebarActive("properties");
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
        <button type="button" class="danger btnDel" data-id="\${id}">×</button>
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
    renderCalendar(state.listings);
  }
}
function setSidebarActive(tab) {
  document.getElementById("side-properties").classList.toggle("active", tab==="properties");
}
async function renderActiveTab() {
  await fetchListings();
  showProperties();
}
document.getElementById("side-properties").onclick=e=>{
  state.selectedTab="properties";renderActiveTab();
};
renderActiveTab();

function renderCalendar(listingIds) {
  let start = new Date(), end = new Date(); end.setDate(start.getDate()+13);
  function formatDate(d){return d.toISOString().split("T")[0];}
  let dates=[],cursor=new Date(start);
  while (cursor<=end) { dates.push(formatDate(cursor)); cursor.setDate(cursor.getDate()+1);}
  let tableHtml = '<div>Dates: '+formatDate(start)+' to '+formatDate(end)+'</div>';
  tableHtml += '<table><thead><tr><th>Listing</th>';
  tableHtml += dates.map(d=>'<th>'+d.slice(5)+'</th>').join("")+"</tr></thead><tbody>";
  tableHtml += listingIds.map(listingId=>'<tr><td><div><strong>'+listingId+'</strong></div></td>'
    +dates.map(date=>'<td><div class="orig-rate">Original: -</div><div class="price">Adjusted: -</div><div class="minstay">Min nights: -</div></td>').join("")
    +'</tr>').join("");
  tableHtml += '</tbody></table>';
  document.getElementById("calendar-hold").innerHTML = tableHtml;
}
</script>
</body>
</html>`);
});

app.listen(PORT, ()=>console.log("Running on "+PORT));

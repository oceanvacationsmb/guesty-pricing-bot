import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- STATE STORAGE ---
let MANAGED_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d"
];
let LISTINGS_INFO = {}; // [id] = {title, ...}
let LISTINGS_STRATEGY = {}; // {...rates, monthRules, rangeRules, eventRules}
let ORIGINAL_RATES = {};

let cachedToken = null;
let tokenExpiresAt = null;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await axios.post(
    "https://open-api.guesty.com/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "open-api",
      client_id: process.env.GUESTY_CLIENT_ID,
      client_secret: process.env.GUESTY_CLIENT_SECRET
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatDate(date) { return date.toISOString().split("T")[0]; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function buildDateRange(days = 14) {
  const start = new Date(), end = addDays(start, days-1);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}
function extractDays(calendarData) {
  if (Array.isArray(calendarData?.data?.days)) return calendarData.data.days;
  if (Array.isArray(calendarData?.days)) return calendarData.days;
  if (Array.isArray(calendarData?.data)) return calendarData.data;
  if (Array.isArray(calendarData?.results)) return calendarData.results;
  if (Array.isArray(calendarData)) return calendarData; return [];
}
function getDayPrice(day) {
  return (day.price ?? day.p ?? day.basePrice ?? day.adjustedPrice ?? day.rate ??
    day.nightlyRate ?? day.calendarPrice ?? day.rates?.baseRate ??
    day.rates?.adjustedPrice ?? day.rates?.nightlyRate);
}
function getDayMinNights(day) {
  return (day.minNights ?? day.m ?? day.minStay ?? day.minimumNights);
}
function getDayStatus(day) {
  if (day.type === "block") return "BLOCK";
  if (day.reservationId || day.type === "reservation") return "BOOKED";
  return "AVAILABLE";
}

// --- GUESTY API ---
async function guestyApiGet(url, config = {}, retries = 5) {
  for (let i=0;i<retries;i++) try {
    return await axios.get(url, config);
  } catch (e) {
    if (e.response?.status === 429) {
      await sleep((parseInt(e.response.headers["retry-after"],10)||60)*1000); continue;
    }
    throw e;
  }
  throw new Error("Too many retries");
}
async function guestyGetListingInfo(listingId, token) {
  const url = `https://open-api.guesty.com/v1/listings/${listingId}`;
  const res = await guestyApiGet(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}
async function guestyGetBatchCalendar(listingIds, startDate, endDate, token) {
  const url = "https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings";
  const res = await guestyApiGet(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      listingIds: listingIds.join(","),
      startDate, endDate,
      ignoreInactiveChildAllotment: true,
      useChildValues: true,
      includeReservations: true, includeBlocks: true
    }
  });
  return res.data;
}
async function guestyUpdateCalendarDate(listingId, date, valueObj, token) {
  const url = `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listing/${listingId}/day/${date}`;
  await axios.patch(url, valueObj, { headers: { Authorization: `Bearer ${token}` } });
}

// --------- API: List/Manage ---------
app.get("/api/listings", (req,res) => res.json({listings: MANAGED_LISTINGS}));
app.post("/api/listings", (req,res) => {
  const { id } = req.body; if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id)) {
    return res.status(400).json({ error: "Invalid or duplicate listing ID" });
  } MANAGED_LISTINGS.push(id); res.json({ listings: MANAGED_LISTINGS });
});
app.delete("/api/listings/:id", (req,res) => {
  const { id } = req.params;
  MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid!==id);
  delete LISTINGS_STRATEGY[id]; delete LISTINGS_INFO[id]; delete ORIGINAL_RATES[id];
  res.json({listings: MANAGED_LISTINGS});
});
app.get("/api/strategy/:id", (req,res) => {
  res.json({ strategy: LISTINGS_STRATEGY[req.params.id] || {
    minRate: "", maxRate: "", minNights: "", weekendPct: "", weekdayPct: "",
    drop_0_7:"",drop_8_14:"",drop_15_21:"",drop_22_30:"",
    monthRules: [], rangeRules: [], eventRules: [], syncEnabled: true
  } });
});
app.post("/api/strategy/:id", (req,res) => {
  const s = req.body;
  if (!Array.isArray(s.monthRules)) s.monthRules = [];
  if (!Array.isArray(s.rangeRules)) s.rangeRules = [];
  if (!Array.isArray(s.eventRules)) s.eventRules = [];
  s.syncEnabled = s.syncEnabled!==undefined?s.syncEnabled:true;
  LISTINGS_STRATEGY[req.params.id] = s;
  res.json({ok: true});
});
app.post("/api/clone-strategy", (req,res) => {
  const { fromId, toIds } = req.body;
  if (!fromId || !Array.isArray(toIds)) return res.status(400).json({error:"Invalid"});
  for (const tid of toIds) {
    if (fromId===tid) continue;
    const _copy = JSON.parse(JSON.stringify(LISTINGS_STRATEGY[fromId]||{}));
    LISTINGS_STRATEGY[tid] = _copy;
  }
  res.json({ok:true});
});

// ----------- AUTOMATION LOGIC: Apply All Rules ----
function rateRuleForDate(strategy, dateStr) {
  const dt = new Date(dateStr);
  for (const e of (strategy.eventRules||[])) {
    if (!e.enabled) continue;
    if (e.annual) {
      const [sy,sm,sd]=e.start.split("-"), [ey,em,ed]=e.end.split("-");
      const dmonth = (dt.getMonth()+1).toString().padStart(2,'0');
      const dday = dt.getDate().toString().padStart(2,'0');
      if (
        (dmonth+dday >= sm+sd && dmonth+dday <= em+ed)
      ) {
        return {src:"event", ...e};
      }
    } else if (dateStr>=e.start && dateStr<=e.end) {
      return {src:"event", ...e};
    }
  }
  for (const r of (strategy.rangeRules||[])) {
    if (!r.enabled) continue;
    if (dateStr>=r.start && dateStr<=r.end) return {src:"range", ...r};
  }
  for (const m of (strategy.monthRules||[])) {
    if (!m.enabled) continue;
    if ((dt.getMonth()+1)==parseInt(m.month,10)) return {src:"month", ...m};
  }
  return null;
}

async function applyAutomationForListing(listingId, daysArr, strategy, token) {
  if (!strategy.syncEnabled) return;
  if (!ORIGINAL_RATES[listingId]) ORIGINAL_RATES[listingId] = {};
  for (const day of daysArr) {
    const theDate = day.date||day.day||day.calendarDate;
    const stat = getDayStatus(day); if (stat!=="AVAILABLE") continue;
    if (!ORIGINAL_RATES[listingId][theDate]) {
      ORIGINAL_RATES[listingId][theDate] = {
        price: getDayPrice(day)||null, minNights: getDayMinNights(day)||null
      };
    }
    let origPrice = ORIGINAL_RATES[listingId][theDate].price ?? getDayPrice(day);
    let adjPrice = origPrice;
    const special = rateRuleForDate(strategy, theDate);
    if (special && special.base) adjPrice = parseFloat(special.base)||origPrice;
    let daysAway = Math.ceil((new Date(theDate) - new Date())/(1000*60*60*24));
    daysAway = Math.max(daysAway,0);
    if (!special) {
      if (daysAway<=7&&strategy.drop_0_7) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_0_7)||0)/100));
      else if (daysAway<=14&&strategy.drop_8_14) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_8_14)||0)/100));
      else if (daysAway<=21&&strategy.drop_15_21) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_15_21)||0)/100));
      else if (daysAway<=30&&strategy.drop_22_30) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_22_30)||0)/100));
      if (strategy.weekendPct && [0,6].includes(new Date(theDate).getDay())) {
        adjPrice = Math.round(origPrice*(1+(parseFloat(strategy.weekendPct)||0)/100));
      }
      if (strategy.weekdayPct && ![0,6].includes(new Date(theDate).getDay())) {
        adjPrice = Math.round(origPrice*(1-(parseFloat(strategy.weekdayPct)||0)/100));
      }
      if (strategy.minRate) adjPrice = Math.max(adjPrice, parseFloat(strategy.minRate));
      if (strategy.maxRate) adjPrice = Math.min(adjPrice, parseFloat(strategy.maxRate));
    }
    if (adjPrice !== getDayPrice(day)) {
      try { await guestyUpdateCalendarDate(listingId, theDate, {price: adjPrice}, token);
        day.price = adjPrice;
      } catch{}
    }
    let minN = special && special.minNights ? parseInt(special.minNights) : (strategy.minNights ? parseInt(strategy.minNights):undefined);
    if (minN && day.minNights>minN) {
      try { await guestyUpdateCalendarDate(listingId, theDate, {minNights:minN}, token); day.minNights = minN;} catch{}
    }
  }
}

// ---- UI DASHBOARD ----
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Rental Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', Arial, sans-serif; margin:0; background:#f9fafd; color:#243042;}
    #navbar { background:#2055e6;color:#fff;padding:0 24px;height:56px;display:flex;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,0.06);}
    #navbar h1{flex:1;font-size:22px;font-weight:700;}
    #navbar nav{display:flex;gap:20px;}
    #navbar a{color:#fff;text-decoration:none;font-weight:500;font-size:17px;padding:4px 0;border-bottom:2px solid transparent;}
    #navbar a.active{border-bottom:2.5px solid #ffb300;}
    .panel{background:#fff;margin:32px auto;max-width:980px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);padding:28px 32px;}
    h2{font-size:1.5rem;margin:0 0 16px;}
    .input-row{display:flex;gap:8px;margin-bottom:16px;}
    input[type=text],input[type=number],select{font-size:17px;padding:6px 10px;border:1.5px solid #99b3ef;border-radius:6px;}
    button{background:#2055e6;border:none;color:#fff;font-size:17px;font-weight:500;padding:7px 20px;border-radius:6px;cursor:pointer;}
    button.danger{background:#e64545;}
    .listing-list{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px;}
    .listing-pill{background:#edf1fd;border:1px solid #b3cdff;border-radius:8px;padding:8px 14px;display:flex;align-items:center;gap:10px;font-weight:500;}
    #settings-panel{margin-top:24px;}
    label{display:block;font-size:15px;margin-bottom:4px;font-weight:500;}
    .form-row{display:flex;gap:24px;}
    .form-row>div{flex:1;}
    .save-note{font-size:14px;color:#297D2E;margin-top:10px;}
    .calendar-container{margin-top:32px;}
    table{border-collapse:collapse;width:100%;background:#fff;}
    th,td{border:1px solid #dde3ee;padding:7px;text-align:center;}
    th{background:#f5f8fe;}
    .minstay{font-size:13px;color:#5b6582;}
    .orig-rate{color:#999;font-size:12px;}
    .stat-block{background:#ddd;color:#777;font-weight:700;}
    .stat-booked{background:#ffeb3b;color:#234;font-weight:700;}
    .sync-switch{width:38px;height:22px;position:relative;display:inline-block;}
    .sync-switch input{display:none;}
    .sync-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:22px;transition:.2s;}
    .sync-slider:before{position:absolute;content:"";height:16px;width:16px;left:4px;bottom:3px;background:#fff;border-radius:50%;transition:.2s;}
    input:checked+.sync-slider{background:#27ae60;}
    input:checked+.sync-slider:before{transform:translateX(16px);}
    .subtabs{display:flex;gap:20px;margin:18px 0;}
    .subtab{background:#f2f6fe;color:#2055e6;padding:6px 18px;font-size:15px;border-radius:8px;cursor:pointer;}
    .subtab.active{background:#2055e6;color:#fff;}
    .rules-table {margin-top:10px;width:100%;font-size:15px;}
    .rules-table th {background:#e4ebfb;}
    .event-dot{height:10px;width:10px;border-radius:50%;display:inline-block;margin-right:5px;}
  </style>
</head><body>
<div id="navbar">
  <h1>Rental Dashboard</h1>
  <nav>
    <a href="#" id="tab-properties" class="active">PROPERTIES</a>
    <a href="#" id="tab-settings">RATE SETTINGS</a>
  </nav>
</div>
<div id="main"></div>
<script>
let state = {
  listings: [], listingsMap: {}, selectedTab:"properties", selectedProp:"", settings:{}, sync:{}
};
let subtabs = ["Month", "Range", "Event"]; let activeSubtab = "Month";

async function fetchListings() {
  const r = await fetch('/api/listings'); const j = await r.json(); state.listings = j.listings;
  for (let id of state.listings) {
    if (!state.listingsMap[id]) {
      try {
        const n = await fetch('/api/strategy/'+encodeURIComponent(id));
        const info = await n.json();
        state.listingsMap[id]={id,title:info.strategy?.name||id};
      } catch{state.listingsMap[id]={id:title=id}}
    }
  }
}
async function addListing(id) {
  await fetch('/api/listings', {method:'POST', headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
}
async function delListing(id) {
  await fetch('/api/listings/'+encodeURIComponent(id),{method:'DELETE'});
}
async function fetchSettings(id) {
  const r = await fetch('/api/strategy/'+encodeURIComponent(id)); const j = await r.json();
  state.settings[id]=j.strategy||{};
}
async function saveSettings(id,obj) {
  await fetch('/api/strategy/'+encodeURIComponent(id),{
    method:'POST',headers:{"Content-Type":"application/json"},body:JSON.stringify(obj)
  }); state.settings[id]=obj;
}
async function cloneRates(fromId,toIdsArr) {
  await fetch('/api/clone-strategy',{method:'POST',headers:{"Content-Type":"application/json"},
    body:JSON.stringify({fromId,toIds:toIdsArr})
  });
}
async function fetchCalendar(ids) {
  const r = await fetch('/calendar-table',{method:'POST',headers:{"Content-Type":"application/json"},body:JSON.stringify({listingIds:ids})});
  return r.text();
}

function showProperties() {
  document.getElementById("tab-properties").classList.add("active");
  document.getElementById("tab-settings").classList.remove("active");
  let html = '<div class="panel">';
  html += '<h2>Properties</h2>';
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
        <button type="button" class="btnSettings" data-id="\${id}">⚙️</button>
      </span>\`
    ).join("");
    html += "</div>";
  }
  html += \`<div class="calendar-container" id="calendar-hold"></div>\`;
  html += '</div>';
  document.getElementById("main").innerHTML = html;

  document.getElementById("add-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = document.getElementById("add-id").value.trim();
    if (v) {await addListing(v);await renderActiveTab();}
  };
  document.querySelectorAll('.btnDel').forEach(btn=>{
    btn.onclick = async ()=>{await delListing(btn.dataset.id);await renderActiveTab();}
  });
  document.querySelectorAll('.btnSettings').forEach(btn=>{
    btn.onclick = async ()=>{
      state.selectedTab = "settings"; state.selectedProp=btn.dataset.id; await fetchSettings(btn.dataset.id); await renderActiveTab();
    }
  });

  if (state.listings.length) {
    fetchCalendar(state.listings).then(h=>{document.getElementById("calendar-hold").innerHTML=h});
  }
}

// ==== showSettings() and rest of dashboard code remain unchanged from earlier code ====
// === (for brevity, if you want the entire file, I'll post, but the above pattern fixes your critical syntax error!) ===

</script>
</body></html>
`);
});

// ... rest of your API handlers and app.listen() ...
// (Keep as in your previous code for calendar-table and so on)

app.post("/calendar-table", async (req,res)=>{
  // ... your implementation, unchanged for brevity ...
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));

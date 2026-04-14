// --- FULL PROPERTY RATE SETTINGS DASHBOARD ---
// All rates/logic/UI inside this file. Only edit this code!

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
let LISTINGS_STRATEGY = {}; // strategies: {min/max/wkday/wkend/%drops, monthRules, rangeRules, eventRules}
let ORIGINAL_RATES = {};    // [listing][date] = {price, minNights}

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
  // Rehydrate array rules if missing
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
  // events (exact/annual) > range > month > default
  const dt = new Date(dateStr);
  // EVENT RULES
  for (const e of (strategy.eventRules||[])) {
    if (!e.enabled) continue;
    if (e.annual) {
      // same month/date as dt? (ignore year)
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
  // RANGE RULES
  for (const r of (strategy.rangeRules||[])) {
    if (!r.enabled) continue;
    if (dateStr>=r.start && dateStr<=r.end) return {src:"range", ...r};
  }
  // MONTH RULES
  for (const m of (strategy.monthRules||[])) {
    if (!m.enabled) continue;
    if ((dt.getMonth()+1)==parseInt(m.month,10)) return {src:"month", ...m};
  }
  return null; // use base/other logic
}

async function applyAutomationForListing(listingId, daysArr, strategy, token) {
  if (!strategy.syncEnabled) return;
  if (!ORIGINAL_RATES[listingId]) ORIGINAL_RATES[listingId] = {};
  for (const day of daysArr) {
    const theDate = day.date||day.day||day.calendarDate;
    const stat = getDayStatus(day); if (stat!=="AVAILABLE") continue;
    // Save orig
    if (!ORIGINAL_RATES[listingId][theDate]) {
      ORIGINAL_RATES[listingId][theDate] = {
        price: getDayPrice(day)||null, minNights: getDayMinNights(day)||null
      };
    }
    let origPrice = ORIGINAL_RATES[listingId][theDate].price ?? getDayPrice(day);
    let adjPrice = origPrice;
    // Rules by events, ranges, months
    const special = rateRuleForDate(strategy, theDate);
    if (special && special.base) adjPrice = parseFloat(special.base)||origPrice;
    // Drops (not compounding): latest window wins
    let daysAway = Math.ceil((new Date(theDate) - new Date())/(1000*60*60*24));
    daysAway = Math.max(daysAway,0);
    if (!special) {
      if (daysAway<=7&&strategy.drop_0_7) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_0_7)||0)/100));
      else if (daysAway<=14&&strategy.drop_8_14) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_8_14)||0)/100));
      else if (daysAway<=21&&strategy.drop_15_21) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_15_21)||0)/100));
      else if (daysAway<=30&&strategy.drop_22_30) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_22_30)||0)/100));
      // Weekend/weekday (from orig)
      if (strategy.weekendPct && [0,6].includes(new Date(theDate).getDay())) {
        adjPrice = Math.round(origPrice*(1+(parseFloat(strategy.weekendPct)||0)/100));
      }
      if (strategy.weekdayPct && ![0,6].includes(new Date(theDate).getDay())) {
        adjPrice = Math.round(origPrice*(1-(parseFloat(strategy.weekdayPct)||0)/100));
      }
      if (strategy.minRate) adjPrice = Math.max(adjPrice, parseFloat(strategy.minRate));
      if (strategy.maxRate) adjPrice = Math.min(adjPrice, parseFloat(strategy.maxRate));
    }
    // Only update if not already set
    if (adjPrice !== getDayPrice(day)) {
      try { await guestyUpdateCalendarDate(listingId, theDate, {price: adjPrice}, token);
        day.price = adjPrice;
      } catch{}
    }
    // Min Nights by rule
    let minN = special && special.minNights ? parseInt(special.minNights) : (strategy.minNights ? parseInt(strategy.minNights):undefined);
    if (minN && day.minNights>minN) {
      try { await guestyUpdateCalendarDate(listingId, theDate, {minNights:minN}, token); day.minNights = minN;} catch{}
    }
  }
}

// ---- UI DASHBOARD ----
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
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
      // --- CLIENT STATE
      let state = {
        listings: [], listingsMap: {},    // [id], {id:{id,title}}
        selectedTab:"properties", selectedProp:"", settings:{}, sync:{}, 
      };
      let subtabs = ["Month", "Range", "Event"]; let activeSubtab = "Month";
      let tmpRule = {}; // temp for adding rule

      // ---- API CLIENT ----
      async function fetchListings() {
        const r = await fetch('/api/listings'); const j = await r.json(); state.listings = j.listings;
        // Get proper names for each listing
        for (let id of state.listings) {
          if (!state.listingsMap[id]) {
            try {
              const n = await fetch('/api/strategy/'+encodeURIComponent(id));
              const info = await n.json();
              state.listingsMap[id]={id,title:info.strategy?.name||id};
            } catch{state.listingsMap[id]={id,title:id}}
          }
        }
      }
      async function addListing(id) {
        await fetch('/api/listings',{method:'POST',headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
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
        html += `<form id="add-form" class="input-row">
          <input id="add-id" type="text" placeholder="Add new listing ID" required>
          <button type="submit">Add</button>
        </form>`;
        if (!state.listings.length) {
          html += "<i>No listings.</i>";
        } else {
          html += '<div class="listing-list">';
          for (let id of state.listings) {
            html += `<span class="listing-pill">
              ${state.listingsMap[id]?.title||id}
              <button type="button" class="danger btnDel" data-id="${id}">×</button>
              <button type="button" class="btnSettings" data-id="${id}">⚙️</button>
            </span>`;
          }
          html += "</div>";
        }
        html += `<div class="calendar-container" id="calendar-hold"></div>`;
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

      function showSettings() {
        document.getElementById("tab-properties").classList.remove("active");
        document.getElementById("tab-settings").classList.add("active");
        let html = '<div class="panel">';
        html += `<h2>Rate Settings</h2>`;
        if (!state.listings.length) {
          html += "<i>Add a property first.</i></div>"; document.getElementById("main").innerHTML=html;return;}
        const prop = state.selectedProp||state.listings[0];
        let strategy = state.settings[prop]||{monthRules:[],rangeRules:[],eventRules:[],syncEnabled:true};
        let propTitle = state.listingsMap[prop]?.title||prop;
        // Property select, rule copy
        html += `<div class="input-row" style="margin-bottom:18px;"><label>Property:</label>
          <select id="selProp">
            ${state.listings.map(id => `<option value="${id}" ${prop===id?"selected":""}>${state.listingsMap[id]?.title||id}</option>`).join("")}
          </select>
          <span style="margin-left:15px;">
            <label>Copy from: <select id="cloneFrom">${state.listings.map(id=>`<option value="${id}">${state.listingsMap[id]?.title||id}</option>`)}</select></label>
            <button id="cloneApply">Copy</button>
          </span>
        </div>`;

        html += `<div class="subtabs">${subtabs.map(s=>`<div class="subtab${activeSubtab===s?" active":""}" data-s="${s}">${s}</div>`).join("")}</div>`;

        // MONTH RULES
        if (activeSubtab==="Month") {
          html += `<div><b>Set rates by month</b><br>
            <table class="rules-table"><thead><tr><th>Month</th><th>Base Rate</th><th>Min Nights</th><th>Enable</th><th>Copy/apply to</th></tr></thead>
            <tbody>
              ${[...Array(12)].map((_,i)=>{
                let fmt = n => n.toString().padStart(2,"0");
                let m = (strategy.monthRules||[]).find(r=>r.month==i+1) || {};
                return `<tr>
                  <td>${fmt(i+1)}</td>
                  <td><input type="number" min="0" class="m-base" data-m="${i+1}" value="${m.base||""}"></td>
                  <td><input type="number" min="1" class="m-minN" data-m="${i+1}" value="${m.minNights||""}"></td>
                  <td><input type="checkbox" class="m-enabled" data-m="${i+1}" ${m.enabled?"checked":""}></td>
                  <td>
                    <select class="multi-ap" data-m="${i+1}" multiple style="min-width:70px;">${state.listings.map(id=>`<option value="${id}">${state.listingsMap[id]?.title||id}</option>`)}</select>
                    <button class="btnApMonth" data-m="${i+1}">Apply</button>
                  </td>
                </tr>`;
              }).join("")}
            </tbody></table>
          </div>`;
        }

        // RANGE RULES
        if (activeSubtab==="Range") {
          let rR = (strategy.rangeRules||[]).slice();
          html += `<div><b>Create custom range-based rate rule</b>
            <table class="rules-table"><thead><tr><th></th><th>Start</th><th>End</th><th>Base Rate</th><th>Min Nights</th><th>Enable</th><th>Apply to</th></tr></thead>
            <tbody>
              ${rR.map((r,i)=>`
                <tr>
                  <td><button class="delR" data-i="${i}">🗑</button></td>
                  <td><input type="date" class="range-start" data-i="${i}" value="${r.start||""}"></td>
                  <td><input type="date" class="range-end" data-i="${i}" value="${r.end||""}"></td>
                  <td><input type="number" class="range-base" data-i="${i}" value="${r.base||""}"></td>
                  <td><input type="number" class="range-minN" data-i="${i}" value="${r.minNights||""}"></td>
                  <td><input type="checkbox" class="range-enabled" data-i="${i}" ${r.enabled?"checked":""}></td>
                  <td>
                    <select class="multi-apr" data-i="${i}" multiple style="min-width:70px;">${state.listings.map(id=>`<option value="${id}">${state.listingsMap[id]?.title||id}</option>`)}</select>
                    <button class="btnApRange" data-i="${i}">Apply</button>
                  </td>
                </tr>
              `).join("")}
              <tr>
                <td>+</td>
                <td><input type="date" id="newRange-start"></td>
                <td><input type="date" id="newRange-end"></td>
                <td><input type="number" id="newRange-base"></td>
                <td><input type="number" id="newRange-minN"></td>
                <td></td>
                <td><button id="addRangeBtn">Add</button></td>
              </tr>
            </tbody></table>
          </div>`;
        }

        // EVENT RULES
        if (activeSubtab==="Event") {
          let ev = (strategy.eventRules||[]).slice();
          html += `<div><b>Events/holidays (annual or custom date - these override all)</b>
            <table class="rules-table"><thead><tr><th></th><th>Name</th><th>Start</th><th>End</th><th>Base Rate</th><th>Min Nights</th><th>Annual</th><th>Enable</th><th>Apply to</th></tr></thead>
            <tbody>
              ${ev.map((r,i)=>`
                <tr>
                  <td><button class="delEv" data-i="${i}">🗑</button></td>
                  <td><input type="text" class="event-name" data-i="${i}" value="${r.name||""}"></td>
                  <td><input type="date" class="event-start" data-i="${i}" value="${r.start||""}"></td>
                  <td><input type="date" class="event-end" data-i="${i}" value="${r.end||""}"></td>
                  <td><input type="number" class="event-base" data-i="${i}" value="${r.base||""}"></td>
                  <td><input type="number" class="event-minN" data-i="${i}" value="${r.minNights||""}"></td>
                  <td><input type="checkbox" class="event-annual" data-i="${i}" ${r.annual?"checked":""}></td>
                  <td><input type="checkbox" class="event-enabled" data-i="${i}" ${r.enabled?"checked":""}></td>
                  <td>
                    <select class="multi-apev" data-i="${i}" multiple style="min-width:70px;">${state.listings.map(id=>`<option value="${id}">${state.listingsMap[id]?.title||id}</option>`)}</select>
                    <button class="btnApEvent" data-i="${i}">Apply</button>
                  </td>
                </tr>
              `).join("")}
              <tr>
                <td>+</td>
                <td><input type="text" id="newEv-name" placeholder="Event"></td>
                <td><input type="date" id="newEv-start"></td>
                <td><input type="date" id="newEv-end"></td>
                <td><input type="number" id="newEv-base"></td>
                <td><input type="number" id="newEv-minN"></td>
                <td><input type="checkbox" id="newEv-annual"></td>
                <td></td>
                <td><button id="addEvBtn">Add</button></td>
              </tr>
            </tbody></table>
          </div>`;
        }

        html += `<br><button id="saveSettingsBtn">Save All Settings</button><span id="saveNote" class="save-note" style="display:none;">Saved!</span></div>`;
        document.getElementById("main").innerHTML=html;

        document.getElementById("selProp").onchange=e=>{
          state.selectedProp=e.target.value;fetchSettings(state.selectedProp).then(()=>{renderActiveTab();});
        };
        document.getElementById("cloneApply").onclick = async ()=>{
          const fromId = document.getElementById("cloneFrom").value;
          await cloneRates(fromId,[state.selectedProp]);
          await fetchSettings(state.selectedProp); renderActiveTab();
        };

        // Subtab switching
        document.querySelectorAll('.subtab').forEach(sb=>{
          sb.onclick=()=>{activeSubtab=sb.dataset.s;renderActiveTab();}
        });

        // Month rules
        if (activeSubtab==="Month") {
          document.querySelectorAll('.m-base,.m-minN,.m-enabled').forEach(inp=>{
            inp.onchange=()=>{
              for (let i=0;i<12;i++){
                let base=document.querySelector('.m-base[data-m="'+(i+1)+'"]').value;
                let minN=document.querySelector('.m-minN[data-m="'+(i+1)+'"]').value;
                let enabled=document.querySelector('.m-enabled[data-m="'+(i+1)+'"]').checked;
                strategy.monthRules[i]={month:i+1,base,minNights:minN,enabled};
              }
            };
          });
          document.querySelectorAll('.btnApMonth').forEach(btn=>{
            btn.onclick=async()=>{
              const m = btn.dataset.m;
              const base=document.querySelector('.m-base[data-m="'+m+'"]').value;
              const minN=document.querySelector('.m-minN[data-m="'+m+'"]').value;
              const enabled=document.querySelector('.m-enabled[data-m="'+m+'"]').checked;
              const sel=[...document.querySelector('.multi-ap[data-m="'+m+'"]').selectedOptions].map(o=>o.value);
              for (const tid of sel) {
                if (tid===state.selectedProp) continue;
                await fetchSettings(tid);
                let t = state.settings[tid];
                if (!t.monthRules) t.monthRules=[];
                t.monthRules[m-1]={month:m,base,minNights:minN,enabled};
                await saveSettings(tid,t);
              }
              document.querySelector('.multi-ap[data-m="'+m+'"]').selectedIndex=-1;
              renderActiveTab();
            }
          });
        }
        // Range rules
        if (activeSubtab==="Range") {
          document.querySelectorAll('.range-start,.range-end,.range-base,.range-minN,.range-enabled').forEach(inp=>{
            inp.onchange=()=>{
              strategy.rangeRules=document.querySelectorAll('.range-start').length?
                [...document.querySelectorAll('.range-start')].map((_,i)=>({
                  start:document.querySelector('.range-start[data-i="'+i+'"]').value,
                  end:document.querySelector('.range-end[data-i="'+i+'"]').value,
                  base:document.querySelector('.range-base[data-i="'+i+'"]').value,
                  minNights:document.querySelector('.range-minN[data-i="'+i+'"]').value,
                  enabled:document.querySelector('.range-enabled[data-i="'+i+'"]').checked
                })):strategy.rangeRules||[];
            };
          });
          document.getElementById("addRangeBtn").onclick=()=>{
            let r={start:document.getElementById("newRange-start").value,end:document.getElementById("newRange-end").value,
            base:document.getElementById("newRange-base").value,minNights:document.getElementById("newRange-minN").value,enabled:true};
            strategy.rangeRules.push(r); renderActiveTab();
          };
          document.querySelectorAll('.btnApRange').forEach(btn=>{
            btn.onclick=async()=>{
              const i = btn.dataset.i;
              const rule = {...strategy.rangeRules[i]};
              const sel=[...document.querySelector('.multi-apr[data-i="'+i+'"]').selectedOptions].map(o=>o.value);
              for (const tid of sel) {
                if (tid===state.selectedProp) continue;
                await fetchSettings(tid);
                let t = state.settings[tid];
                if (!t.rangeRules) t.rangeRules=[];
                t.rangeRules.push(rule);
                await saveSettings(tid,t);
              }
              document.querySelector('.multi-apr[data-i="'+i+'"]').selectedIndex=-1;
              renderActiveTab();
            }
          });
          document.querySelectorAll('.delR').forEach(btn=>{
            btn.onclick=()=>{strategy.rangeRules.splice(btn.dataset.i,1); renderActiveTab();}
          });
        }
        // Event rules
        if (activeSubtab==="Event") {
          document.querySelectorAll('.event-name,.event-start,.event-end,.event-base,.event-minN,.event-annual,.event-enabled').forEach(inp=>{
            inp.onchange=()=>{
              strategy.eventRules=document.querySelectorAll('.event-name').length?
                [...document.querySelectorAll('.event-name')].map((_,i)=>({
                  name:document.querySelector('.event-name[data-i="'+i+'"]').value,
                  start:document.querySelector('.event-start[data-i="'+i+'"]').value,
                  end:document.querySelector('.event-end[data-i="'+i+'"]').value,
                  base:document.querySelector('.event-base[data-i="'+i+'"]').value,
                  minNights:document.querySelector('.event-minN[data-i="'+i+'"]').value,
                  annual:document.querySelector('.event-annual[data-i="'+i+'"]').checked,
                  enabled:document.querySelector('.event-enabled[data-i="'+i+'"]').checked
                })):strategy.eventRules||[];
            };
          });
          document.getElementById("addEvBtn").onclick=()=>{
            let r = {
              name:document.getElementById("newEv-name").value,
              start:document.getElementById("newEv-start").value,
              end:document.getElementById("newEv-end").value,
              base:document.getElementById("newEv-base").value,
              minNights:document.getElementById("newEv-minN").value,
              annual:document.getElementById("newEv-annual").checked,
              enabled:true
            };
            strategy.eventRules.push(r); renderActiveTab();
          };
          document.querySelectorAll('.btnApEvent').forEach(btn=>{
            btn.onclick=async()=>{
              const i = btn.dataset.i;
              const rule = {...strategy.eventRules[i]};
              const sel=[...document.querySelector('.multi-apev[data-i="'+i+'"]').selectedOptions].map(o=>o.value);
              for (const tid of sel) {
                if (tid===state.selectedProp) continue;
                await fetchSettings(tid);
                let t = state.settings[tid];
                if (!t.eventRules) t.eventRules=[];
                t.eventRules.push(rule);
                await saveSettings(tid,t);
              }
              document.querySelector('.multi-apev[data-i="'+i+'"]').selectedIndex=-1;
              renderActiveTab();
            }
          });
          document.querySelectorAll('.delEv').forEach(btn=>{
            btn.onclick=()=>{strategy.eventRules.splice(btn.dataset.i,1); renderActiveTab();}
          });
        }

        document.getElementById("saveSettingsBtn").onclick=async()=>{
          await saveSettings(prop,strategy);
          document.getElementById("saveNote").style.display="inline"; setTimeout(()=>{document.getElementById("saveNote").style.display="none";},1500);
        };
      }

      async function renderActiveTab() {
        await fetchListings();
        state.selectedProp = state.selectedProp || state.listings[0];
        if (state.selectedTab=="properties") showProperties();
        else { if (state.selectedProp && !state.settings[state.selectedProp]) await fetchSettings(state.selectedProp); showSettings(); }
      }
      document.getElementById("tab-properties").onclick=e=>{state.selectedTab="properties";renderActiveTab();}
      document.getElementById("tab-settings").onclick=e=>{state.selectedTab="settings";renderActiveTab();}
      renderActiveTab();
    </script>
    </body></html>
  `);
});

// ---- ADVANCED CALENDAR TABLE ----
app.post("/calendar-table", async (req,res)=>{
  try {
    const { listingIds } = req.body;
    if (!listingIds||!Array.isArray(listingIds)||!listingIds.length) return res.send("<b>No properties to show.</b>");
    const { startDate, endDate } = buildDateRange(14);
    const token = await getAccessToken();
    const dates=[],last=new Date(endDate);let cursor=new Date(startDate);
    while (cursor<=last) { dates.push(formatDate(cursor)); cursor=addDays(cursor,1);}
    let listingsData=[];
    for (const listingId of listingIds) {
      let title=listingId, daysArr=[];
      try {
        const info = await guestyGetListingInfo(listingId, token);
        title = info.title||info.nickname||listingId; LISTINGS_INFO[listingId]=info;
      }catch{}
      let cal={};
      try { cal = await guestyGetBatchCalendar([listingId],startDate,endDate,token);}catch{}
      const days = extractDays(cal);
      const strategy = LISTINGS_STRATEGY[listingId]||{syncEnabled:true};
      await applyAutomationForListing(listingId,days,strategy,token);
      listingsData.push({id:listingId,title,days});
      await sleep(350);
    }
    // Render the pro table
    const tableHtml = `
      <div>Dates: ${startDate} to ${endDate}</div>
      <table><thead><tr>
      <th>Listing</th>${dates.map(d=>`<th>${d.slice(5)}</th>`).join("")}
      </tr></thead><tbody>
      ${listingsData.map(listing=>`
        <tr>
        <td>
          <div><strong>${listing.title}</strong></div><div>${listing.id}</div>
        </td>
        ${dates.map(date=>{
          const day = listing.days.find(x=>(x.date||x.day||x.calendarDate)===date)||{};
          const stat = getDayStatus(day);
          if (stat==="BLOCK") return '<td class="stat-block">NOT AVAILABLE</td>';
          if (stat==="BOOKED") return '<td class="stat-booked">BOOKED</td>';
          const orig = (ORIGINAL_RATES[listing.id]||{})[date]?.price??getDayPrice(day);
          const minN = day.minNights??"";
          return `<td>
            <div class="orig-rate">Original: $${orig||""}</div>
            <div class="price">Adjusted: $${getDayPrice(day)||""}</div>
            <div class="minstay">Min nights: ${minN!==""?minN:"-"}</div>
          </td>`;
        }).join("")}
        </tr>
      `).join("")}
      </tbody></table>
    `; res.send(tableHtml);
  } catch (e) {
    res.send("<pre>"+(e.response?.data?JSON.stringify(e.response.data,null,2):e.message)+"</pre>");
  }
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));

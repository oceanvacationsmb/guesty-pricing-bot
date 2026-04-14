import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---- SYSTEM STATE ----

// Managed listing IDs
let MANAGED_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d",
  "69db0826f579c50013546169"
];

// Store settings for each property
let LISTING_STRATEGIES = {}; // { [listingId]: { ...strategy, syncEnabled:true/false } }

// Store original rates/minNights to allow reversion if needed
let ORIGINAL_RATES = {}; // { [listingId]: { [date]: { price, minNights } } }

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
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Guesty GET helpers ----

async function guestyApiGet(url, config = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      if (e.response?.status === 429) {
        const retryAfter = e.response.headers["retry-after"];
        const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
        console.log(`Rate limited. Waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Too many retries due to rate limiting.");
}

async function guestyGetListingInfo(listingId, token) {
  const url = `https://open-api.guesty.com/v1/listings/${listingId}`;
  const res = await guestyApiGet(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
}

async function guestyGetBatchCalendar(listingIds, startDate, endDate, token) {
  const url = "https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings";
  const res = await guestyApiGet(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      listingIds: listingIds.join(","),
      startDate,
      endDate,
      ignoreInactiveChildAllotment: true,
      useChildValues: true,
      includeReservations: true,
      includeBlocks: true
    }
  });
  return res.data;
}

// ---- Guesty PATCH (for pricing/min nights update) ----

async function guestyUpdateCalendarDate(listingId, date, valueObj, token) {
  // Patch a single date for price or minNights
  const url = `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listing/${listingId}/day/${date}`;
  await axios.patch(url, valueObj, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

// ---- UTIL ----

function formatDate(date) {
  return date.toISOString().split("T")[0];
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function buildDateRange(days = 14) {
  const start = new Date();
  const end = addDays(start, days - 1);
  return {
    startDate: formatDate(start),
    endDate: formatDate(end)
  };
}
function extractDays(calendarData) {
  if (Array.isArray(calendarData?.data?.days)) return calendarData.data.days;
  if (Array.isArray(calendarData?.days)) return calendarData.days;
  if (Array.isArray(calendarData?.data)) return calendarData.data;
  if (Array.isArray(calendarData?.results)) return calendarData.results;
  if (Array.isArray(calendarData)) return calendarData;
  return [];
}
function getDayPrice(day) {
  return (
    day.price ??
    day.p ??
    day.basePrice ??
    day.adjustedPrice ??
    day.rate ??
    day.nightlyRate ??
    day.calendarPrice ??
    day.rates?.baseRate ??
    day.rates?.adjustedPrice ??
    day.rates?.nightlyRate
  );
}
function getDayMinNights(day) {
  return (
    day.minNights ??
    day.m ??
    day.minStay ??
    day.minimumNights
  );
}
function getDayStatus(day) {
  if (day.type === "block") return "BLOCK";
  if (day.reservationId || day.type === "reservation") return "BOOKED";
  return "AVAILABLE";
}

// ---- EXPRESS API: Properties & Strategies ----

// List all managed listings
app.get("/api/listings", (req, res) => {
  res.json({ listings: MANAGED_LISTINGS });
});
app.post("/api/listings", (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id)) {
    return res.status(400).json({ error: "Invalid or duplicate listing ID" });
  }
  MANAGED_LISTINGS.push(id);
  res.json({ listings: MANAGED_LISTINGS });
});
app.delete("/api/listings/:id", (req, res) => {
  const { id } = req.params;
  MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid !== id);
  delete LISTING_STRATEGIES[id];
  delete ORIGINAL_RATES[id];
  res.json({ listings: MANAGED_LISTINGS });
});
app.get("/api/strategy/:id", (req, res) => {
  res.json({ strategy: LISTING_STRATEGIES[req.params.id] || { syncEnabled:true } });
});
app.post("/api/strategy/:id", (req, res) => {
  const strategy = req.body;
  strategy.syncEnabled = strategy.syncEnabled!==undefined ? strategy.syncEnabled : true;
  LISTING_STRATEGIES[req.params.id] = strategy;
  res.json({ ok: true });
});
app.post("/api/sync-toggle/:id", async (req, res) => {
  const { enabled } = req.body;
  const id = req.params.id;
  if (!LISTING_STRATEGIES[id]) LISTING_STRATEGIES[id] = {};
  LISTING_STRATEGIES[id].syncEnabled = !!enabled;
  // On disable, restore rates/min nights from ORIGINAL_RATES
  if (!enabled && ORIGINAL_RATES[id]) {
    const token = await getAccessToken();
    for (const [date, orig] of Object.entries(ORIGINAL_RATES[id])) {
      try {
        await guestyUpdateCalendarDate(id, date, { price: orig.price, minNights: orig.minNights }, token);
      } catch(e) {
        // log and continue
      }
    }
  }
  res.json({syncEnabled: !!enabled});
});

// ---- AUTOMATION: Adjust Rates & Min Nights ----

async function applyAutomationForListing(listingId, daysArr, strategy, token) {
  if (!strategy.syncEnabled) return;
  if (!ORIGINAL_RATES[listingId]) ORIGINAL_RATES[listingId] = {};
  // Loop through days (open only, not booked/block)
  for (const day of daysArr) {
    const theDate = day.date || day.day || day.calendarDate;
    // Preserve only open/available:
    const stat = getDayStatus(day);
    if (stat !== "AVAILABLE") continue;
    // Save original value if not saved yet
    if (!ORIGINAL_RATES[listingId][theDate]) {
      ORIGINAL_RATES[listingId][theDate] = {
        price: getDayPrice(day) ?? null,
        minNights: getDayMinNights(day) ?? null
      };
    }
    // Adjust Rate:
    let origPrice = ORIGINAL_RATES[listingId][theDate].price || getDayPrice(day);
    let adjPrice = origPrice;
    // Pick interval & % (never cumulative)
    let daysAway = Math.ceil((new Date(theDate) - new Date()) / (1000*60*60*24));
    daysAway = Math.max(daysAway, 0);
    if (daysAway <= 7 && strategy.drop_0_7) adjPrice = Math.round(origPrice * (1 - (parseFloat(strategy.drop_0_7)||0)/100));
    else if (daysAway <= 14 && strategy.drop_8_14) adjPrice = Math.round(origPrice * (1 - (parseFloat(strategy.drop_8_14)||0)/100));
    else if (daysAway <= 21 && strategy.drop_15_21) adjPrice = Math.round(origPrice * (1 - (parseFloat(strategy.drop_15_21)||0)/100));
    else if (daysAway <= 30 && strategy.drop_22_30) adjPrice = Math.round(origPrice * (1 - (parseFloat(strategy.drop_22_30)||0)/100));
    // No drop for further out, or nothing configured
    // Apply weekday/weekend rules
    if (strategy.weekendPct && [0,6].includes(new Date(theDate).getDay())) {
      adjPrice = Math.round(origPrice * (1 + (parseFloat(strategy.weekendPct)||0)/100));
    }
    if (strategy.weekdayPct && ![0,6].includes(new Date(theDate).getDay())) {
      adjPrice = Math.round(origPrice * (1 - (parseFloat(strategy.weekdayPct)||0)/100));
    }
    // Clamp min/max
    if (strategy.minRate) adjPrice = Math.max(adjPrice, parseFloat(strategy.minRate));
    if (strategy.maxRate) adjPrice = Math.min(adjPrice, parseFloat(strategy.maxRate));
    // Only update if not already adjusted (no repeat compounding)
    if (adjPrice !== getDayPrice(day)) {
      try {
        await guestyUpdateCalendarDate(listingId, theDate, { price: adjPrice }, token);
        // Update our in-memory state
        day.price = adjPrice;
      } catch (e) { }
    }
    // --- GAP/AUTOMINNIGHTS BOT: Fill gap nights automatically if min nights is higher than allowed
    if (strategy.minNights) {
      if (day.minNights > parseInt(strategy.minNights)) {
        try {
          await guestyUpdateCalendarDate(listingId, theDate, { minNights: parseInt(strategy.minNights) }, token);
          day.minNights = parseInt(strategy.minNights);
        } catch(e) {}
      }
    }
  }
}

// ---- DASHBOARD: Professional Admin Web App ----

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Rental Dashboard</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
      <style>
        body { font-family: 'Inter', Arial, sans-serif; margin: 0; background: #f9fafd; color: #243042; }
        #navbar { background: #2055e6; color: #fff; padding: 0 24px; height: 56px; display: flex; align-items: center; box-shadow: 0 1px 4px rgba(0,0,0,0.06);}
        #navbar h1 { flex:1; font-size: 22px; font-weight: 700; margin: 0;}
        #navbar nav { display: flex; gap: 20px; }
        #navbar a { color: #fff; text-decoration: none; font-weight: 500; font-size: 17px; padding: 4px 0; border-bottom: 2px solid transparent;}
        #navbar a.active { border-bottom: 2.5px solid #ffb300;}
        .panel { background: #fff; margin: 32px auto; max-width: 920px; border-radius: 12px; box-shadow:0 4px 24px rgba(0,0,0,0.1); padding: 28px 32px;}
        h2 { font-size: 1.5rem; margin: 0 0 16px;}
        .input-row { display:flex; gap:8px; margin-bottom:16px;}
        input[type=text], input[type=number] { font-size: 18px; padding: 6px 10px; border: 1.5px solid #99b3ef; border-radius: 6px;}
        button { background: #2055e6; border: none; color: #fff; font-size: 17px; font-weight: 500; padding:6px 20px; border-radius: 6px; cursor:pointer; }
        button.danger { background: #e64545; }
        .listing-list { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
        .listing-pill { background: #edf1fd; border: 1px solid #b3cdff; border-radius: 8px; padding: 8px 18px; display: flex; align-items: center; gap: 10px; font-weight: 500;}
        #settings-panel {margin-top:24px;}
        label { display:block; font-size:15px; margin-bottom:4px;font-weight: 500;}
        .form-row { display:flex; gap:24px;}
        .form-row > div { flex:1;}
        .save-note { font-size: 14px; color: #297D2E; margin-top: 10px;}
        .calendar-container {margin-top:32px;}
        table { border-collapse: collapse; width: 100%; background: #fff;}
        th, td { border: 1px solid #dde3ee; padding: 7px; text-align: center;}
        th { background: #f5f8fe;}
        .minstay { font-size:13px; color:#5b6582;}
        .orig-rate { color:#999;font-size:12px;}
        .stat-block { background:#ddd;color:#777;font-weight:700; }
        .stat-booked { background:#ffeb3b;color:#234; font-weight:700; }
        .sync-switch {width:38px;height:22px;position:relative;display:inline-block;}
        .sync-switch input { display:none; }
        .sync-slider {position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:22px;transition:.2s;}
        .sync-slider:before {position:absolute;content:"";height:16px;width:16px;left:4px;bottom:3px;background:#fff;border-radius:50%;transition:.2s;}
        input:checked + .sync-slider {background:#27ae60;}
        input:checked + .sync-slider:before {transform:translateX(16px);}
      </style>
    </head>
    <body>
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
          listings: [],
          selectedTab: "properties",
          selectedProp: "",
          settings: {},
          syncStates: {} // { id: true/false }
        };
        // --- API calls ---
        async function fetchListings() {
          const res = await fetch('/api/listings');
          state.listings = (await res.json()).listings;
        }
        async function addListing(id) {
          await fetch('/api/listings', {
            method:'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
          });
        }
        async function delListing(id) {
          await fetch('/api/listings/' + encodeURIComponent(id), { method:'DELETE' });
        }
        async function fetchSettings(id) {
          const res = await fetch('/api/strategy/' + encodeURIComponent(id));
          const out = await res.json();
          state.settings[id] = out.strategy || {};
          state.syncStates[id] = out.strategy && out.strategy.syncEnabled !== false;
        }
        async function saveSettings(id, obj) {
          await fetch('/api/strategy/' + encodeURIComponent(id), {
            method:'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(obj)
          });
          state.settings[id] = obj;
          state.syncStates[id] = obj.syncEnabled !== false;
        }
        async function setSync(id, enabled) {
          await fetch('/api/sync-toggle/' + encodeURIComponent(id), {
            method:'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({enabled})
          });
          state.syncStates[id]=enabled;
        }
        async function fetchCalendar(ids) {
          const res = await fetch('/calendar-table', {
            method:'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ listingIds: ids })
          });
          return await res.text();
        }
        // --- UI rendering ---
        function navBarUpdate() {
          document.getElementById("tab-properties").classList.toggle("active", state.selectedTab=="properties");
          document.getElementById("tab-settings").classList.toggle("active", state.selectedTab=="settings");
        }
        function showProperties() {
          navBarUpdate();
          let html = '<div class="panel">';
          html += '<h2>Properties</h2>';
          html += `<form id="add-form" class="input-row">
            <input id="add-id" type="text" placeholder="Add new listing ID" required>
            <button type="submit">Add</button>
          </form>`;
          if (!state.listings.length) {
            html += "<i>No listings managed yet.</i>";
          } else {
            html += '<div class="listing-list">';
            for (let id of state.listings) {
              html += `<span class="listing-pill">
                ${id}
                <button type="button" class="danger btnDel" data-id="${id}" title="Remove listing">×</button>
                <button type="button" class="btnSettings" data-id="${id}">⚙️</button>
                <label class="sync-switch" title="Automation Sync On/Off">
                  <input type="checkbox" class="sync-toggle" data-id="${id}" ${state.syncStates[id]!==false?'checked':''}>
                  <span class="sync-slider"></span>
                </label>
              </span>`;
            }
            html += "</div>";
          }
          html += `<div class="calendar-container" id="calendar-hold"></div>`;
          html += '</div>';
          document.getElementById("main").innerHTML = html;

          // Form handlers
          document.getElementById("add-form").onsubmit = async (e) => {
            e.preventDefault();
            const input = document.getElementById("add-id");
            const val = input.value.trim();
            if (!val) return;
            await addListing(val);
            input.value = "";
            await renderActiveTab();
          };
          document.querySelectorAll('.btnDel').forEach(btn => {
            btn.onclick = async () => {
              await delListing(btn.dataset.id);
              await renderActiveTab();
            }
          });
          document.querySelectorAll('.btnSettings').forEach(btn => {
            btn.onclick = async () => {
              state.selectedTab = "settings";
              state.selectedProp = btn.dataset.id;
              await fetchSettings(btn.dataset.id);
              await renderActiveTab();
            }
          });
          document.querySelectorAll('.sync-toggle').forEach(toggle => {
            toggle.onchange = async () => {
              await setSync(toggle.dataset.id, toggle.checked);
              state.syncStates[toggle.dataset.id]=toggle.checked;
              await renderActiveTab();
            };
          });
          if (state.listings.length) {
            fetchCalendar(state.listings).then(html => {
              document.getElementById("calendar-hold").innerHTML = html;
            });
          }
        }
        function showSettings() {
          navBarUpdate();
          let html = '<div class="panel">';
          html += '<h2>Rate Settings</h2>';
          if (!state.listings.length) {
            html += "<i>Please add a property first.</i></div>";
            document.getElementById("main").innerHTML = html; return;
          }
          html += `
            <div class="input-row" style="margin-bottom:18px;">
              <label for="selProp" style="margin:0 18px 0 0;">Choose Property:</label>
              <select id="selProp" style="font-size:17px;">
                ${state.listings.map(id => `<option value="${id}" ${state.selectedProp===id?"selected":""}>${id}</option>`).join("")}
              </select>
              <label class="sync-switch" title="Automation Sync On/Off" style="margin-left:18px;">
                <input type="checkbox" id="sync-toggle-settings" ${state.syncStates[state.selectedProp]!==false?'checked':''}>
                <span class="sync-slider"></span>
              </label>
            </div>
          `;
          let current = state.settings[state.selectedProp] || {
            minRate: "",
            maxRate: "",
            weekendPct: "",
            weekdayPct: "",
            minNights: "",
            drop_0_7: "",
            drop_8_14: "",
            drop_15_21: "",
            drop_22_30: "",
            syncEnabled: true
          };
          html += `
            <form id="settings-form">
            <div class="form-row">
              <div>
                <label>Min Rate ($)</label>
                <input type="number" min="0" name="minRate" value="${current.minRate||""}">
              </div>
              <div>
                <label>Max Rate ($)</label>
                <input type="number" min="0" name="maxRate" value="${current.maxRate||""}">
              </div>
              <div>
                <label>Min Nights</label>
                <input type="number" min="1" name="minNights" value="${current.minNights||""}">
              </div>
            </div>
            <div class="form-row">
              <div>
                <label>Weekend Rate Increase (%)</label>
                <input type="number" min="0" max="500" name="weekendPct" value="${current.weekendPct||""}">
              </div>
              <div>
                <label>Weekday Rate Decrease (%)</label>
                <input type="number" min="0" max="100" name="weekdayPct" value="${current.weekdayPct||""}">
              </div>
            </div>
            <div>
              <label>Auto Price Drop (%) by Days to Check-In:</label>
              <div class="form-row">
                <div><input type="number" name="drop_0_7" min="0" max="100" value="${current.drop_0_7||""}"><span style="font-size:12px;margin-left:6px;">0-7 days</span></div>
                <div><input type="number" name="drop_8_14" min="0" max="100" value="${current.drop_8_14||""}"><span style="font-size:12px;margin-left:6px;">8-14 days</span></div>
                <div><input type="number" name="drop_15_21" min="0" max="100" value="${current.drop_15_21||""}"><span style="font-size:12px;margin-left:6px;">15-21 days</span></div>
                <div><input type="number" name="drop_22_30" min="0" max="100" value="${current.drop_22_30||""}"><span style="font-size:12px;margin-left:6px;">22-30 days</span></div>
              </div>
            </div>
            <br>
            <button type="submit">Save</button>
            </form>
            <div id="save-note" class="save-note" style="display:none;">Settings saved!</div>
          `;
          html += '</div>';
          document.getElementById("main").innerHTML = html;
          document.getElementById("selProp").onchange = async e => {
            state.selectedProp = e.target.value;
            if (!state.settings[state.selectedProp]) await fetchSettings(state.selectedProp);
            renderActiveTab();
          };
          document.getElementById("settings-form").onsubmit = async (e) => {
            e.preventDefault();
            const f = e.target;
            const form = new FormData(f);
            const val = {};
            for (const [k,v] of form.entries()) val[k] = v;
            val.syncEnabled = document.getElementById("sync-toggle-settings").checked;
            await saveSettings(state.selectedProp, val);
            document.getElementById("save-note").style.display = "block";
            setTimeout(() => { document.getElementById("save-note").style.display = "none"; }, 1500);
          };
          document.getElementById("sync-toggle-settings").onchange = async e => {
            await setSync(state.selectedProp, e.target.checked);
            state.syncStates[state.selectedProp]=e.target.checked;
          }
        }
        async function renderActiveTab() {
          await fetchListings();
          if (!state.selectedProp && state.listings.length) state.selectedProp = state.listings[0];
          if (state.selectedTab=="properties") {
            showProperties();
          } else {
            if (state.selectedProp && !state.settings[state.selectedProp]) await fetchSettings(state.selectedProp);
            showSettings();
          }
        }
        document.getElementById("tab-properties").onclick = e => { state.selectedTab="properties"; renderActiveTab(); };
        document.getElementById("tab-settings").onclick = e => { state.selectedTab="settings"; renderActiveTab(); };
        renderActiveTab();
      </script>
    </body>
    </html>
  `);
});

// ---- PRO CALENDAR TABLE with GAP/AUTO-MIN NIGHTS/AUTOMATION ----
app.post("/calendar-table", async (req, res) => {
  try {
    const { listingIds } = req.body;
    if (!listingIds || !Array.isArray(listingIds) || !listingIds.length) {
      return res.send("<b>No properties to show.</b>");
    }
    const { startDate, endDate } = buildDateRange(14);
    const token = await getAccessToken();

    const dates = [];
    let cursor = new Date(startDate);
    const last = new Date(endDate);
    while (cursor <= last) {
      dates.push(formatDate(cursor));
      cursor = addDays(cursor, 1);
    }
    // For all listings, fetch info and calendar & apply automation (in background)
    let listingsData = [];
    for (const listingId of listingIds) {
      let title = listingId, daysArr = [];
      try {
        const info = await guestyGetListingInfo(listingId, token);
        title = info.title || info.nickname || listingId;
      } catch(e) {}
      let calendarData = {};
      try {
        calendarData = await guestyGetBatchCalendar([listingId], startDate, endDate, token); // Just this listing
      } catch(e) {}
      const days = extractDays(calendarData);
      // Apply pricing/min nights automation only on open dates
      const strategy = LISTING_STRATEGIES[listingId] || { syncEnabled:true };
      await applyAutomationForListing(listingId, days, strategy, token);
      listingsData.push({ id: listingId, title, days });
      await sleep(350);
    }
    // Render table w/ original, adjusted, min nights, status for each cell
    const tableHtml = `
      <div>Dates: ${startDate} to ${endDate}</div>
      <table>
        <thead>
          <tr>
            <th>Listing</th>
            ${dates.map(d => `<th>${d.slice(5)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${listingsData.map(listing => `
            <tr>
              <td>
                <div><strong>${listing.title}</strong></div>
                <div>${listing.id}</div>
              </td>
              ${dates.map(date => {
                const day = listing.days.find(x => (x.date||x.day||x.calendarDate)===date) || {};
                const stat = getDayStatus(day);
                if (stat==="BLOCK") {
                  return `<td class="stat-block">NOT AVAILABLE</td>`;
                }
                if (stat==="BOOKED") {
                  return `<td class="stat-booked">BOOKED</td>`;
                }
                const orig = (ORIGINAL_RATES[listing.id]||{})[date]?.price ?? getDayPrice(day);
                const minN = day.minNights ?? "";
                return `
                  <td>
                    <div class="orig-rate">Original: $${orig||""}</div>
                    <div class="price">Adjusted: $${getDayPrice(day)||""}</div>
                    <div class="minstay">Min nights: ${minN!==""?minN:"-"}</div>
                  </td>
                `;
              }).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    res.send(tableHtml);
  } catch (e) {
    res.send("<pre>" + (e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message) + "</pre>");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

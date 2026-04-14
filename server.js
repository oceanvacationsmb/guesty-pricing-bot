import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

let MANAGED_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d",
  "69db0826f579c50013546169"
];

let LISTING_STRATEGIES = {
  "69db18d8085e450014e2bf65": createDefaultStrategy(),
  "69db12c790763a00130d40bc": createDefaultStrategy(),
  "69db12bff579c50013548a0d": createDefaultStrategy(),
  "69db0826f579c50013546169": createDefaultStrategy()
};

let cachedToken = null;
let tokenExpiresAt = null;

function createDefaultStrategy() {
  return {
    enabled: true,
    pct: -20,
    min: 100,
    max: 10000,
    minNights: 1,
    maxNights: 30,
    weekdayPct: 0,
    weekendPct: 0,
    seasonalRules: [
      { name: "Summer", startDate: "", endDate: "", pct: 0, min: "", max: "", minNights: "", maxNights: "" },
      { name: "Fall", startDate: "", endDate: "", pct: 0, min: "", max: "", minNights: "", maxNights: "" },
      { name: "Winter", startDate: "", endDate: "", pct: 0, min: "", max: "", minNights: "", maxNights: "" }
    ],
    eventRules: [
      { name: "Event 1", startDate: "", endDate: "", pct: 0, min: "", max: "", minNights: "", maxNights: "" },
      { name: "Event 2", startDate: "", endDate: "", pct: 0, min: "", max: "", minNights: "", maxNights: "" }
    ]
  };
}

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
      useChildValues: true
    }
  });

  return res.data;
}

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
  if (day.status !== undefined && day.status !== null) return day.status;
  if (day.available !== undefined && day.available !== null) return day.available;
  if (day.isAvailable !== undefined && day.isAvailable !== null) return day.isAvailable;
  if (day.reserved !== undefined && day.reserved !== null) return !day.reserved;
  return null;
}

function isWeekend(dateStr) {
  const day = new Date(dateStr).getDay();
  return day === 5 || day === 6;
}

function inRange(dateStr, rule) {
  if (!rule?.startDate || !rule?.endDate) return false;
  return dateStr >= rule.startDate && dateStr <= rule.endDate;
}

function toNumberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function normalizeRule(rule) {
  return {
    name: rule?.name || "",
    startDate: rule?.startDate || "",
    endDate: rule?.endDate || "",
    pct: toNumberOrNull(rule?.pct) ?? 0,
    min: toNumberOrNull(rule?.min),
    max: toNumberOrNull(rule?.max),
    minNights: toNumberOrNull(rule?.minNights),
    maxNights: toNumberOrNull(rule?.maxNights)
  };
}

function normalizeStrategy(input = {}) {
  return {
    enabled: input.enabled === true || input.enabled === "true" || input.enabled === "on",
    pct: toNumberOrNull(input.pct) ?? 0,
    min: toNumberOrNull(input.min) ?? 0,
    max: toNumberOrNull(input.max) ?? 0,
    minNights: toNumberOrNull(input.minNights) ?? 1,
    maxNights: toNumberOrNull(input.maxNights) ?? 30,
    weekdayPct: toNumberOrNull(input.weekdayPct) ?? 0,
    weekendPct: toNumberOrNull(input.weekendPct) ?? 0,
    seasonalRules: Array.isArray(input.seasonalRules)
      ? input.seasonalRules.map(normalizeRule)
      : createDefaultStrategy().seasonalRules,
    eventRules: Array.isArray(input.eventRules)
      ? input.eventRules.map(normalizeRule)
      : createDefaultStrategy().eventRules
  };
}

function getAppliedRule(strategy, dateStr) {
  if (!strategy?.enabled) {
    return { label: "Disabled", pct: 0, min: strategy?.min, max: strategy?.max, minNights: strategy?.minNights, maxNights: strategy?.maxNights };
  }

  for (const rule of strategy.eventRules || []) {
    if (inRange(dateStr, rule)) {
      return { label: `Event: ${rule.name || "Custom Event"}`, ...rule };
    }
  }

  for (const rule of strategy.seasonalRules || []) {
    if (inRange(dateStr, rule)) {
      return { label: `Season: ${rule.name || "Season"}`, ...rule };
    }
  }

  if (isWeekend(dateStr) && strategy.weekendPct) {
    return {
      label: "Weekend",
      pct: strategy.weekendPct,
      min: strategy.min,
      max: strategy.max,
      minNights: strategy.minNights,
      maxNights: strategy.maxNights
    };
  }

  if (!isWeekend(dateStr) && strategy.weekdayPct) {
    return {
      label: "Weekday",
      pct: strategy.weekdayPct,
      min: strategy.min,
      max: strategy.max,
      minNights: strategy.minNights,
      maxNights: strategy.maxNights
    };
  }

  return {
    label: "Default",
    pct: strategy.pct,
    min: strategy.min,
    max: strategy.max,
    minNights: strategy.minNights,
    maxNights: strategy.maxNights
  };
}

function applyStrategy(price, strategy, dateStr) {
  if (!strategy || !strategy.enabled || price === null || price === undefined) {
    return {
      newPrice: price,
      ruleLabel: "Disabled",
      minNights: strategy?.minNights ?? null,
      maxNights: strategy?.maxNights ?? null
    };
  }

  const applied = getAppliedRule(strategy, dateStr);
  let newPrice = price + (price * ((applied.pct ?? 0) / 100));

  if (applied.min) newPrice = Math.max(newPrice, applied.min);
  if (applied.max) newPrice = Math.min(newPrice, applied.max);

  return {
    newPrice: Math.round(newPrice),
    ruleLabel: applied.label,
    minNights: applied.minNights ?? strategy.minNights ?? null,
    maxNights: applied.maxNights ?? strategy.maxNights ?? null
  };
}

function pageTemplate(title, activePage, content, extraScripts = "") {
  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${title}</title>
      <style>
        :root{
  --bg:#f5f7fb;
  --panel:#ffffff;
  --panel-2:#f8fafc;
  --line:#dbe3ef;
  --text:#1f2937;
  --muted:#6b7280;
          --accent:#5b8cff;
          --accent-2:#29c7ac;
          --danger:#ff6b6b;
          --warning:#ffb547;
          --success:#2ecc71;
          --shadow:0 10px 30px rgba(0,0,0,.25);
          --radius:18px;
        }
        * { box-sizing:border-box; }
        body {
  margin:0;
  font-family: Inter, Arial, sans-serif;
  background:#f5f7fb;
  color:var(--text);
}
        .app {
          display:grid;
          grid-template-columns: 260px 1fr;
          min-height:100vh;
        }
        .sidebar {
  background:#ffffff;
  border-right:1px solid var(--line);
  padding:24px 18px;
          position:sticky;
          top:0;
          height:100vh;
        }
        .brand {
          font-size:22px;
          font-weight:800;
          margin-bottom:24px;
          letter-spacing:.3px;
        }
        .brand span {
          color:var(--accent);
        }
        .nav-section-title {
          color:var(--muted);
          font-size:12px;
          text-transform:uppercase;
          letter-spacing:1.1px;
          margin:22px 10px 10px;
        }
        .nav a {
          display:flex;
          align-items:center;
          gap:12px;
          color:var(--text);
          text-decoration:none;
          padding:12px 14px;
          border-radius:14px;
          margin-bottom:8px;
          background:transparent;
          border:1px solid transparent;
          transition:.2s ease;
          font-weight:600;
        }
        .nav a:hover {
          background:rgba(91,140,255,.12);
          border-color:rgba(91,140,255,.2);
        }
        .nav a.active {
          background:linear-gradient(90deg, rgba(91,140,255,.18), rgba(41,199,172,.12));
          border-color:rgba(91,140,255,.35);
          box-shadow:var(--shadow);
        }
        .sidebar-note {
          margin-top:22px;
          padding:14px;
          border-radius:16px;
          background:var(--panel);
          border:1px solid var(--line);
          color:var(--muted);
          font-size:13px;
          line-height:1.45;
        }
        .main {
          padding:26px;
        }
        .topbar {
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:16px;
          margin-bottom:22px;
        }
        .page-title {
          font-size:28px;
          font-weight:800;
          margin:0;
        }
        .page-subtitle {
          color:var(--muted);
          margin-top:6px;
          font-size:14px;
        }
        .chip-row {
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }
        .chip {
          background:var(--panel);
          border:1px solid var(--line);
          border-radius:999px;
          padding:10px 14px;
          color:var(--muted);
          font-size:13px;
        }
        .grid {
          display:grid;
          gap:20px;
        }
        .grid-2 {
          grid-template-columns:repeat(2, minmax(0, 1fr));
        }
        .grid-3 {
          grid-template-columns:repeat(3, minmax(0, 1fr));
        }
        .card {
          background:linear-gradient(180deg, rgba(18,26,43,.98), rgba(18,26,43,.92));
          border:1px solid var(--line);
          border-radius:var(--radius);
          padding:20px;
          box-shadow:var(--shadow);
        }
        .card-title {
          font-size:18px;
          font-weight:800;
          margin:0 0 6px;
        }
        .card-subtitle {
          color:var(--muted);
          font-size:13px;
          margin-bottom:16px;
        }
        .stats {
          display:grid;
          grid-template-columns:repeat(4,minmax(0,1fr));
          gap:14px;
        }
        .stat {
          background:var(--panel);
          border:1px solid var(--line);
          border-radius:16px;
          padding:16px;
        }
        .stat-label {
          color:var(--muted);
          font-size:12px;
          text-transform:uppercase;
          letter-spacing:1px;
          margin-bottom:6px;
        }
        .stat-value {
          font-size:24px;
          font-weight:800;
        }
        .btn, button {
          appearance:none;
          border:none;
          border-radius:12px;
          padding:11px 16px;
          font-weight:700;
          cursor:pointer;
          transition:.2s ease;
        }
        .btn-primary {
          background:linear-gradient(90deg, var(--accent), #7b6dff);
          color:white;
        }
        .btn-secondary {
          background:var(--panel-2);
          color:var(--text);
          border:1px solid var(--line);
        }
        .btn-danger {
          background:rgba(255,107,107,.14);
          color:#ffd5d5;
          border:1px solid rgba(255,107,107,.25);
        }
        .btn-success {
          background:rgba(46,204,113,.14);
          color:#d7ffe7;
          border:1px solid rgba(46,204,113,.25);
        }
        .btn:hover, button:hover {
          transform:translateY(-1px);
          filter:brightness(1.04);
        }
        .row {
          display:flex;
          gap:12px;
          align-items:center;
          flex-wrap:wrap;
        }
        .field-grid {
          display:grid;
          grid-template-columns:repeat(4,minmax(0,1fr));
          gap:14px;
        }
        .field-grid-2 {
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:14px;
        }
        .field {
          display:flex;
          flex-direction:column;
          gap:8px;
        }
        .field label {
          color:var(--muted);
          font-size:13px;
          font-weight:600;
        }
        input, textarea, select {
          width:100%;
          background:var(--panel-2);
          color:var(--text);
          border:1px solid var(--line);
          border-radius:12px;
          padding:12px 13px;
          font-size:14px;
          outline:none;
        }
        input:focus, textarea:focus, select:focus {
          border-color:var(--accent);
          box-shadow:0 0 0 3px rgba(91,140,255,.14);
        }
        table {
          width:100%;
          border-collapse:collapse;
        }
        th, td {
          border-bottom:1px solid var(--line);
          padding:14px 10px;
          text-align:left;
          vertical-align:top;
        }
        th {
          color:var(--muted);
          font-size:12px;
          text-transform:uppercase;
          letter-spacing:1px;
        }
        .calendar-wrap {
          overflow:auto;
          border-radius:16px;
          border:1px solid var(--line);
          background:var(--panel);
        }
        .calendar-table {
          min-width:1100px;
        }
        .calendar-table th, .calendar-table td {
          text-align:center;
          min-width:110px;
          border-bottom:1px solid var(--line);
        }
        .calendar-table th:first-child, .calendar-table td:first-child {
  text-align:left;
  min-width:250px;
  position:sticky;
  left:0;
  background:#ffffff;
  z-index:5;
}
        .price-original {
          font-size:15px;
          font-weight:800;
        }
        .price-new {
          margin-top:6px;
          font-size:14px;
          font-weight:800;
          color:var(--accent-2);
        }
        .price-rule {
          margin-top:6px;
          font-size:11px;
          color:var(--muted);
        }
        .small-text {
          color:var(--muted);
          font-size:12px;
        }
        .strategy-box {
          background:rgba(255,255,255,.02);
          border:1px solid var(--line);
          border-radius:16px;
          padding:16px;
          margin-top:14px;
        }
        .toggle {
          display:flex;
          align-items:center;
          gap:10px;
        }
        .toggle input {
          width:auto;
          transform:scale(1.2);
        }
        .listing-pill {
          display:inline-block;
          background:rgba(91,140,255,.12);
          border:1px solid rgba(91,140,255,.24);
          color:#d9e5ff;
          border-radius:999px;
          padding:7px 11px;
          margin:4px 6px 0 0;
          font-size:12px;
          font-weight:700;
        }
        .banner {
          padding:14px 16px;
          border-radius:16px;
          background:linear-gradient(90deg, rgba(41,199,172,.14), rgba(91,140,255,.12));
          border:1px solid rgba(91,140,255,.24);
          margin-bottom:18px;
          color:#dff9f3;
        }
        @media (max-width: 1100px) {
          .app { grid-template-columns: 1fr; }
          .sidebar { position:relative; height:auto; }
          .stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
          .grid-2, .grid-3, .field-grid, .field-grid-2 { grid-template-columns:1fr; }
        }
      </style>
    </head>
    <body>
      <div class="app">
        <aside class="sidebar">
          <div class="brand">Pricing <span>Studio</span></div>
          <nav class="nav">
            <div class="nav-section-title">Main</div>
            <a class="${activePage === "dashboard" ? "active" : ""}" href="/dashboard">Dashboard</a>
            <a class="${activePage === "calendar" ? "active" : ""}" href="/calendar">Calendar</a>
            <a class="${activePage === "settings" ? "active" : ""}" href="/settings">Settings</a>
            <a class="${activePage === "listings" ? "active" : ""}" href="/listings">Listings</a>
          </nav>
          <div class="sidebar-note">
            Managed scope only.<br/><br/>
            This UI works only with your selected test listings and keeps the current strategy preview read only.
          </div>
        </aside>
        <main class="main">
          ${content}
        </main>
      </div>
      ${extraScripts}
    </body>
    </html>
  `;
}

async function getListingsDataWithTitles(token) {
  const listingsData = [];
  for (const listingId of MANAGED_LISTINGS) {
    let title = listingId;
    try {
      const info = await guestyGetListingInfo(listingId, token);
      title = info.nickname || info.title || "Property";
    } catch (e) {
      console.log("LISTING INFO ERROR:", listingId, e.response?.data || e.message);
    }
    listingsData.push({ id: listingId, title });
    await sleep(500);
  }
  return listingsData;
}

async function getRatesMap(token, startDate, endDate) {
  const calendarData = await guestyGetBatchCalendar(MANAGED_LISTINGS, startDate, endDate, token);
  const ratesMap = {};
  const days = extractDays(calendarData);

  for (const day of days) {
    const listingId = day.listingId || day.listing?._id || day.listing?.id;
    const date = day.date || day.day || day.calendarDate;
    if (!listingId || !date) continue;

    if (!ratesMap[listingId]) ratesMap[listingId] = {};

    const originalPrice = getDayPrice(day);
    const strategy = LISTING_STRATEGIES[listingId] || createDefaultStrategy();
    const applied = applyStrategy(originalPrice, strategy, date);

    ratesMap[listingId][date] = {
      price: originalPrice,
      newPrice: applied.newPrice,
      ruleLabel: applied.ruleLabel,
      minNights: getDayMinNights(day),
      strategyMinNights: applied.minNights,
      strategyMaxNights: applied.maxNights
    };
  }

  return ratesMap;
}

app.get("/api/listings", (req, res) => {
  res.json({ listings: MANAGED_LISTINGS });
});

app.post("/api/listings", (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id)) {
    return res.status(400).json({ error: "Invalid or duplicate listing ID" });
  }
  MANAGED_LISTINGS.push(id);
  if (!LISTING_STRATEGIES[id]) {
    LISTING_STRATEGIES[id] = createDefaultStrategy();
  }
  res.json({ listings: MANAGED_LISTINGS });
});

app.delete("/api/listings/:id", (req, res) => {
  const { id } = req.params;
  MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid !== id);
  delete LISTING_STRATEGIES[id];
  res.json({ listings: MANAGED_LISTINGS });
});

app.get("/api/strategy/:id", (req, res) => {
  res.json({ strategy: LISTING_STRATEGIES[req.params.id] || createDefaultStrategy() });
});

app.post("/api/strategy/:id", (req, res) => {
  const id = req.params.id;

  if (!MANAGED_LISTINGS.includes(id)) {
    return res.status(400).json({ error: "Listing not allowed" });
  }

  const strategy = normalizeStrategy(req.body);
  LISTING_STRATEGIES[id] = strategy;

  console.log("SAVED STRATEGY:", id, strategy);

  res.json({ ok: true, strategy });
});

app.get("/listings", async (req, res) => {
  const content = `
    <div class="topbar">
      <div>
        <h1 class="page-title">Listings</h1>
        <div class="page-subtitle">Add or remove listings inside your managed scope.</div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Add Listing</div>
        <div class="card-subtitle">Add a listing ID to the managed list.</div>
        <form id="addListingForm" class="field-grid-2">
          <div class="field">
            <label>Listing ID</label>
            <input name="id" placeholder="Guesty listing ID" />
          </div>
          <div class="field" style="justify-content:end;">
            <label>&nbsp;</label>
            <button class="btn btn-primary" type="submit">Add Listing</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-title">Managed IDs</div>
        <div class="card-subtitle">Only these listings are used by the preview and settings pages.</div>
        <div id="listingPills">
          ${MANAGED_LISTINGS.map(id => `<span class="listing-pill">${id}</span>`).join("")}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:20px;">
      <div class="card-title">Current Managed Listings</div>
      <div class="card-subtitle">Remove listings you do not want in this system.</div>
      <table>
        <thead>
          <tr>
            <th>Listing ID</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${MANAGED_LISTINGS.map(id => `
            <tr>
              <td>${id}</td>
              <td>
                <button class="btn btn-danger" onclick="removeListing('${id}')">Remove</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  const scripts = `
    <script>
      document.getElementById("addListingForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = { id: fd.get("id") };

        const res = await fetch("/api/listings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) {
          alert(data.error || "Failed to add listing");
          return;
        }

        location.reload();
      });

      async function removeListing(id) {
        if (!confirm("Remove this listing from managed scope?")) return;

        const res = await fetch("/api/listings/" + encodeURIComponent(id), {
          method: "DELETE"
        });

        if (!res.ok) {
          alert("Failed to remove listing");
          return;
        }

        location.reload();
      }
    </script>
  `;

  res.send(pageTemplate("Listings", "listings", content, scripts));
});

app.get("/settings", async (req, res) => {
  const token = await getAccessToken();
  const listingsData = await getListingsDataWithTitles(token);

  const content = `
    <div class="topbar">
      <div>
        <h1 class="page-title">Settings</h1>
        <div class="page-subtitle">Configure base strategy, seasonal ranges, event ranges, and nights rules per listing.</div>
      </div>
    </div>

    ${listingsData.map(listing => {
      const strategy = LISTING_STRATEGIES[listing.id] || createDefaultStrategy();

      return `
        <form class="card strategy-form" data-id="${listing.id}" style="margin-bottom:20px;">
          <div class="row" style="justify-content:space-between;">
            <div>
              <div class="card-title">${listing.title}</div>
              <div class="card-subtitle">${listing.id}</div>
            </div>
            <div class="toggle">
              <input type="checkbox" name="enabled" ${strategy.enabled ? "checked" : ""} />
              <label>Enable strategy</label>
            </div>
          </div>

          <div class="strategy-box">
            <div class="card-subtitle">Base Pricing Settings</div>
            <div class="field-grid">
              <div class="field">
                <label>Default %</label>
                <input type="number" step="1" name="pct" value="${strategy.pct}" />
              </div>
              <div class="field">
                <label>Min Price</label>
                <input type="number" step="1" name="min" value="${strategy.min}" />
              </div>
              <div class="field">
                <label>Max Price</label>
                <input type="number" step="1" name="max" value="${strategy.max}" />
              </div>
              <div class="field">
                <label>Weekday %</label>
                <input type="number" step="1" name="weekdayPct" value="${strategy.weekdayPct}" />
              </div>
              <div class="field">
                <label>Weekend %</label>
                <input type="number" step="1" name="weekendPct" value="${strategy.weekendPct}" />
              </div>
              <div class="field">
                <label>Min Nights</label>
                <input type="number" step="1" name="minNights" value="${strategy.minNights}" />
              </div>
              <div class="field">
                <label>Max Nights</label>
                <input type="number" step="1" name="maxNights" value="${strategy.maxNights}" />
              </div>
            </div>
          </div>

          <div class="strategy-box">
            <div class="card-subtitle">Seasonal Rules</div>
            ${(strategy.seasonalRules || []).map((rule, idx) => `
              <div class="field-grid" style="margin-bottom:12px;">
                <div class="field">
                  <label>Name</label>
                  <input name="seasonalRules[${idx}][name]" value="${rule.name || ""}" />
                </div>
                <div class="field">
                  <label>Start Date</label>
                  <input type="date" name="seasonalRules[${idx}][startDate]" value="${rule.startDate || ""}" />
                </div>
                <div class="field">
                  <label>End Date</label>
                  <input type="date" name="seasonalRules[${idx}][endDate]" value="${rule.endDate || ""}" />
                </div>
                <div class="field">
                  <label>%</label>
                  <input type="number" name="seasonalRules[${idx}][pct]" value="${rule.pct || 0}" />
                </div>
                <div class="field">
                  <label>Min</label>
                  <input type="number" name="seasonalRules[${idx}][min]" value="${rule.min ?? ""}" />
                </div>
                <div class="field">
                  <label>Max</label>
                  <input type="number" name="seasonalRules[${idx}][max]" value="${rule.max ?? ""}" />
                </div>
                <div class="field">
                  <label>Min Nights</label>
                  <input type="number" name="seasonalRules[${idx}][minNights]" value="${rule.minNights ?? ""}" />
                </div>
                <div class="field">
                  <label>Max Nights</label>
                  <input type="number" name="seasonalRules[${idx}][maxNights]" value="${rule.maxNights ?? ""}" />
                </div>
              </div>
            `).join("")}
          </div>

          <div class="strategy-box">
            <div class="card-subtitle">Event Rules</div>
            ${(strategy.eventRules || []).map((rule, idx) => `
              <div class="field-grid" style="margin-bottom:12px;">
                <div class="field">
                  <label>Name</label>
                  <input name="eventRules[${idx}][name]" value="${rule.name || ""}" />
                </div>
                <div class="field">
                  <label>Start Date</label>
                  <input type="date" name="eventRules[${idx}][startDate]" value="${rule.startDate || ""}" />
                </div>
                <div class="field">
                  <label>End Date</label>
                  <input type="date" name="eventRules[${idx}][endDate]" value="${rule.endDate || ""}" />
                </div>
                <div class="field">
                  <label>%</label>
                  <input type="number" name="eventRules[${idx}][pct]" value="${rule.pct || 0}" />
                </div>
                <div class="field">
                  <label>Min</label>
                  <input type="number" name="eventRules[${idx}][min]" value="${rule.min ?? ""}" />
                </div>
                <div class="field">
                  <label>Max</label>
                  <input type="number" name="eventRules[${idx}][max]" value="${rule.max ?? ""}" />
                </div>
                <div class="field">
                  <label>Min Nights</label>
                  <input type="number" name="eventRules[${idx}][minNights]" value="${rule.minNights ?? ""}" />
                </div>
                <div class="field">
                  <label>Max Nights</label>
                  <input type="number" name="eventRules[${idx}][maxNights]" value="${rule.maxNights ?? ""}" />
                </div>
              </div>
            `).join("")}
          </div>

          <div class="row" style="margin-top:16px;">
            <button class="btn btn-primary" type="submit">Save Settings</button>
            <span class="small-text">Changes affect preview only right now.</span>
          </div>
        </form>
      `;
    }).join("")}
  `;

  const scripts = `
    <script>
      function parseFormToObject(form) {
        const fd = new FormData(form);
        const obj = {
          enabled: false,
          pct: 0,
          min: 0,
          max: 0,
          minNights: 1,
          maxNights: 30,
          weekdayPct: 0,
          weekendPct: 0,
          seasonalRules: [],
          eventRules: []
        };

        for (const [key, value] of fd.entries()) {
          if (key === "enabled") {
            obj.enabled = true;
            continue;
          }

          const seasonalMatch = key.match(/^seasonalRules\\[(\\d+)\\]\\[(.+)\\]$/);
          if (seasonalMatch) {
            const idx = Number(seasonalMatch[1]);
            const field = seasonalMatch[2];
            if (!obj.seasonalRules[idx]) obj.seasonalRules[idx] = {};
            obj.seasonalRules[idx][field] = value;
            continue;
          }

          const eventMatch = key.match(/^eventRules\\[(\\d+)\\]\\[(.+)\\]$/);
          if (eventMatch) {
            const idx = Number(eventMatch[1]);
            const field = eventMatch[2];
            if (!obj.eventRules[idx]) obj.eventRules[idx] = {};
            obj.eventRules[idx][field] = value;
            continue;
          }

          obj[key] = value;
        }

        obj.seasonalRules = obj.seasonalRules.filter(Boolean);
        obj.eventRules = obj.eventRules.filter(Boolean);

        return obj;
      }

      document.querySelectorAll(".strategy-form").forEach(form => {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const id = form.dataset.id;
          const payload = parseFormToObject(form);

          const res = await fetch("/api/strategy/" + encodeURIComponent(id), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          const data = await res.json();
          if (!res.ok) {
            alert(data.error || "Failed to save settings");
            return;
          }

          alert("Settings saved");
        });
      });
    </script>
  `;

  res.send(pageTemplate("Settings", "settings", content, scripts));
});

app.get("/calendar", async (req, res) => {
  try {
    const { startDate, endDate } = buildDateRange(3);
    const token = await getAccessToken();
    const listingsData = await getListingsDataWithTitles(token);
    const ratesMap = await getRatesMap(token, startDate, endDate);

    const dates = [];
    let cursor = new Date(startDate);
    const last = new Date(endDate);
    while (cursor <= last) {
      dates.push(formatDate(cursor));
      cursor = addDays(cursor, 1);
    }

    const content = `
      <div class="topbar">
        <div>
          <h1 class="page-title">Calendar</h1>
          <div class="page-subtitle">Original Guesty rate and calculated strategy rate side by side.</div>
        </div>
        <div class="chip-row">
          <div class="chip">Dates: ${startDate} → ${endDate}</div>
          <div class="chip">Managed Listings: ${MANAGED_LISTINGS.length}</div>
        </div>
      </div>

      <div class="calendar-wrap">
        <table class="calendar-table">
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
                  
                </td>
                ${dates.map(date => {
  const cell = (ratesMap[listing.id] && ratesMap[listing.id][date]) || {};
  return `
    <td>
      <div class="price-original">${cell.price !== undefined && cell.price !== null ? `$${cell.price}` : "-"}</div>
      <div class="price-new">${cell.newPrice !== undefined && cell.newPrice !== null ? `$${cell.newPrice}` : ""}</div>
      <div class="price-rule">${cell.ruleLabel || ""}</div>
      <div class="small-text" style="margin-top:6px; color:${cell.status === false ? "#dc2626" : "#16a34a"};">
        ${cell.status === false ? "Booked" : "Available"}
      </div>
      <div class="small-text">${cell.minNights !== undefined && cell.minNights !== null ? `Guesty min ${cell.minNights}` : ""}</div>
    </td>
  `;
}).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    res.send(pageTemplate("Calendar", "calendar", content));
  } catch (e) {
    res.status(500).send(`<pre>${JSON.stringify(e.response?.data || e.message, null, 2)}</pre>`);
  }
});


      }
    }

    const content = `
      <div class="topbar">
        <div>
          <h1 class="page-title">Preview</h1>
          <div class="page-subtitle">Detailed row view for original price, preview price, and applied rule.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Strategy Preview</div>
        <div class="card-subtitle">This is still read only. No values are written back to Guesty.</div>
        <table>
          <thead>
            <tr>
              <th>Listing</th>
              <th>Date</th>
              <th>Original</th>
              <th>Preview</th>
              <th>Rule</th>
              <th>Guesty Min Nights</th>
              <th>Strategy Min Nights</th>
              <th>Strategy Max Nights</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>
                  <div><strong>${r.title}</strong></div>
                  <div class="small-text">${r.id}</div>
                </td>
                <td>${r.date}</td>
                <td>${r.original !== undefined && r.original !== null ? `$${r.original}` : "-"}</td>
                <td>${r.preview !== undefined && r.preview !== null ? `$${r.preview}` : "-"}</td>
                <td>${r.rule || "-"}</td>
                <td>${r.guestyMin ?? "-"}</td>
                <td>${r.strategyMin ?? "-"}</td>
                <td>${r.strategyMax ?? "-"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    res.send(pageTemplate("Preview", "preview", content));
  } catch (e) {
    res.status(500).send(`<pre>${JSON.stringify(e.response?.data || e.message, null, 2)}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

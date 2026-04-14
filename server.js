import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* ================= STATE ================= */

let MANAGED_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d"
];

let LISTINGS_STRATEGY = {};
let ORIGINAL_RATES = {};

let cachedToken = null;
let tokenExpiresAt = null;

/* ================= HELPERS ================= */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function buildDateRange(days = 14) {
  const start = new Date();
  const end = addDays(start, days - 1);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function getDayPrice(day) {
  return (
    day.price ??
    day.basePrice ??
    day.adjustedPrice ??
    day.rate ??
    day.rates?.baseRate
  );
}

function getDayMinNights(day) {
  return day.minNights ?? day.minimumNights;
}

function getDayStatus(day) {
  if (day.type === "block") return "BLOCK";
  if (day.reservationId) return "BOOKED";
  return "AVAILABLE";
}

/* ================= AUTH ================= */

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

/* ================= GUESTY ================= */

async function guestyGetCalendar(listingId, startDate, endDate, token) {
  const url = "https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings";

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      listingIds: listingId,
      startDate,
      endDate
    }
  });

  return res.data?.days || [];
}

async function guestyUpdate(listingId, date, patch, token) {
  const url = `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listing/${listingId}/day/${date}`;

  await axios.patch(url, patch, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

/* ================= LOGIC ================= */

async function applyPricing(listingId, days, strategy, token) {
  if (!ORIGINAL_RATES[listingId]) ORIGINAL_RATES[listingId] = {};

  for (const day of days) {
    const date = day.date;
    if (!date) continue;

    if (getDayStatus(day) !== "AVAILABLE") continue;

    if (!ORIGINAL_RATES[listingId][date]) {
      ORIGINAL_RATES[listingId][date] = getDayPrice(day);
    }

    let orig = ORIGINAL_RATES[listingId][date];
    let price = orig;

    const target = parseLocalDate(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let daysAway = Math.ceil((target - today) / 86400000);
    daysAway = Math.max(daysAway, 0);

    /* ===== DROPS ===== */
    if (daysAway <= 7 && strategy.drop_0_7) {
      price *= 1 - strategy.drop_0_7 / 100;
    } else if (daysAway <= 14 && strategy.drop_8_14) {
      price *= 1 - strategy.drop_8_14 / 100;
    }

    /* ===== WEEKEND ===== */
    const dow = target.getDay();

    if (strategy.weekendPct && (dow === 0 || dow === 6)) {
      price *= 1 + strategy.weekendPct / 100;
    }

    if (strategy.weekdayPct && dow !== 0 && dow !== 6) {
      price *= 1 - strategy.weekdayPct / 100;
    }

    price = Math.round(price);

    const patch = {};

    if (price !== getDayPrice(day)) patch.price = price;

    if (Object.keys(patch).length) {
      try {
        await guestyUpdate(listingId, date, patch, token);
        day.price = price;
      } catch (e) {
        console.log("ERROR:", e.response?.data || e.message);
      }
    }
  }
}

/* ================= ROUTES ================= */

app.get("/api/listings", (req, res) => {
  res.json({ listings: MANAGED_LISTINGS });
});

/* ================= UI ================= */

app.get("/", (req, res) => {
  res.send(`
  <html>
  <body style="font-family:Arial;padding:20px">

  <h2>Guesty Pricing Tool</h2>

  <button onclick="load()">Load Calendar</button>

  <div id="out"></div>

  <script>
    async function load(){
      const r = await fetch('/run');
      const t = await r.text();
      document.getElementById('out').innerHTML = t;
    }
  </script>

  </body>
  </html>
  `);
});

/* ================= RUN ================= */

app.get("/run", async (req, res) => {
  try {
    const token = await getAccessToken();
    const { startDate, endDate } = buildDateRange(14);

    let html = "";

    for (const id of MANAGED_LISTINGS) {
      const days = await guestyGetCalendar(id, startDate, endDate, token);

      const strategy = LISTINGS_STRATEGY[id] || {
        weekendPct: 10,
        drop_0_7: 20
      };

      await applyPricing(id, days, strategy, token);

      html += `<h3>${id}</h3>`;
      html += `<pre>${JSON.stringify(days.slice(0,5), null, 2)}</pre>`;
    }

    res.send(html);

  } catch (e) {
    res.send(e.response?.data || e.message);
  }
});

/* ================= START ================= */

app.listen(PORT, () => console.log("RUNNING " + PORT));

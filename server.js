import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Manage your listings here. You can add/remove via API!
let MANAGED_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d",
  "69db0826f579c50013546169"
];

// Store strategies per listing for future enhancement
let LISTING_STRATEGIES = {};

// ========== LISTING MANAGEMENT ENDPOINTS ==========

// List all managed listings
app.get("/api/listings", (req, res) => {
  res.json({ listings: MANAGED_LISTINGS });
});

// Add a listing by ID
app.post("/api/listings", (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id)) {
    return res.status(400).json({ error: "Invalid or duplicate listing ID" });
  }
  MANAGED_LISTINGS.push(id);
  res.json({ listings: MANAGED_LISTINGS });
});

// Remove a listing by ID
app.delete("/api/listings/:id", (req, res) => {
  const { id } = req.params;
  MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid !== id);
  delete LISTING_STRATEGIES[id];
  res.json({ listings: MANAGED_LISTINGS });
});

// In the future: Manage strategy for each property (scaffold)
app.get("/api/strategy/:id", (req, res) => {
  res.json({ strategy: LISTING_STRATEGIES[req.params.id] || {} });
});
app.post("/api/strategy/:id", (req, res) => {
  const strategy = req.body;
  LISTING_STRATEGIES[req.params.id] = strategy;
  res.json({ ok: true });
});

// ================== EXISTING CODE ==================

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

// ================== UI ROUTES ==================

app.get("/", (req, res) => {
  res.send(`
    <h2>Read Only Multi Calendar</h2>
    <a href="/calendar">VIEW CALENDAR</a>
  `);
});

app.get("/calendar", (req, res) => {
  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Property Manager Calendar</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h2 { margin-bottom: 16px; }
        #panel { background: #eef; padding: 18px; border-radius: 8px; margin-bottom: 20px; }
        #add-form { display: inline-flex; gap: 8px; }
        #add-form input { font-size: 16px; padding: 4px; }
        #listings-list { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
        .listing-pill { background: #dde; border-radius: 5px; padding: 7px 12px; display: flex; align-items: center; gap: 8px; }
        .listing-del { color: #c00; cursor: pointer; font-weight: bold; margin-left: 7px; }
        #calendar-holder { margin-top: 30px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: top; }
        th:first-child, td:first-child { text-align: left; min-width: 220px; }
        th { background: #f5f5f5; }
        .price { font-weight: bold; }
        .minstay { color: #666; font-size: 12px; margin-top: 4px; }
      </style>
    </head>
    <body>
      <h2>Property Manager Calendar</h2>
      <a href="/">HOME</a> &nbsp; <a href="/calendar">VIEW CALENDAR</a>
      <div id="panel">
        <b>Managed Listing IDs:</b>
        <form id="add-form">
          <input id="add-id" type="text" placeholder="Add listing ID" required />
          <button type="submit">Add</button>
        </form>
        <div id="listings-list"></div>
        <div style="font-size:13px;margin-top:9px;color:#666;">
          Add/remove property IDs you want to manage. Calendar updates automatically!
        </div>
      </div>
      <div id="calendar-holder"></div>
      <script>
        // Helper: get managed listings
        const getListings = async () => {
          const res = await fetch("/api/listings");
          const data = await res.json();
          return data.listings;
        };

        // Render the add/remove panel
        const renderListings = (listings) => {
          const listDiv = document.getElementById("listings-list");
          if (!listings.length) {
            listDiv.innerHTML = "<i>No property IDs managed yet</i>";
            return;
          }
          listDiv.innerHTML = listings.map(id => 
            '<span class="listing-pill">' +
              id + ' <span class="listing-del" data-id="'+id+'" title="remove">&#x2716;</span>' +
            '</span>'
          ).join("");
          Array.from(document.querySelectorAll(".listing-del")).forEach(btn => {
            btn.onclick = async () => {
              await fetch("/api/listings/"+btn.dataset.id, { method: "DELETE" });
              loadAll();
            };
          });
        };

        // Add new property via form
        document.getElementById("add-form").onsubmit = async (e) => {
          e.preventDefault();
          const id = document.getElementById("add-id").value.trim();
          if (!id) return;
          await fetch("/api/listings", { 
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }) 
          });
          document.getElementById("add-id").value = "";
          loadAll();
        };

        // Render the calendar table
        const renderCalendar = (calendarHtml) => {
          document.getElementById("calendar-holder").innerHTML = calendarHtml;
        };

        // Server call to get calendar HTML
        const loadCalendar = async (ids) => {
          if (!ids.length) {
            renderCalendar("<b>No properties to show.</b>");
            return;
          }
          const res = await fetch("/calendar-table", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ listingIds: ids })
          });
          const html = await res.text();
          renderCalendar(html);
        };

        // Main loader
        const loadAll = async () => {
          const ids = await getListings();
          renderListings(ids);
          loadCalendar(ids);
        };

        loadAll();
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

// NEW: API endpoint to render the calendar HTML
app.post("/calendar-table", async (req, res) => {
  try {
    const { listingIds } = req.body;
    if (!listingIds || !Array.isArray(listingIds) || !listingIds.length) {
      return res.send("<b>No properties to show.</b>");
    }
    const { startDate, endDate } = buildDateRange(3);
    const token = await getAccessToken();

    const dates = [];
    let cursor = new Date(startDate);
    const last = new Date(endDate);

    while (cursor <= last) {
      dates.push(formatDate(cursor));
      cursor = addDays(cursor, 1);
    }

    const listingsData = [];
    for (const listingId of listingIds) {
      let title = listingId;
      try {
        const info = await guestyGetListingInfo(listingId, token);
        title = info.title || info.nickname || listingId;
      } catch {
        // ignore fetch errors
      }
      listingsData.push({ id: listingId, title });
      await sleep(500);
    }

    const calendarData = await guestyGetBatchCalendar(listingIds, startDate, endDate, token);

    const ratesMap = {};
    const days = extractDays(calendarData);

    for (const day of days) {
      const listingId = day.listingId || day.listing?._id || day.listing?.id;
      const date = day.date || day.day || day.calendarDate;
      if (!listingId || !date) continue;
      if (!ratesMap[listingId]) ratesMap[listingId] = {};
      ratesMap[listingId][date] = {
        price: getDayPrice(day),
        minNights: getDayMinNights(day)
      };
    }

    // Render only the table HTML (not whole document)
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
                const cell = (ratesMap[listing.id] && ratesMap[listing.id][date]) || {};
                return `
                  <td>
                    <div class="price">${cell.price !== undefined && cell.price !== null ? `$${cell.price}` : "-"}</div>
                    <div class="minstay">${cell.minNights !== undefined && cell.minNights !== null ? `min ${cell.minNights}` : ""}</div>
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

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TEST_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d",
  "69db0826f579c50013546169"
];

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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function guestyGetListingInfo(listingId, token) {
  const url = `https://open-api.guesty.com/v1/listings/${listingId}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
}

async function guestyGetCalendar(listingId, startDate, endDate, token) {
  const url = `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${listingId}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: { startDate, endDate } // <-- FIXED PARAM NAMES
  });

  const calendar = res.data.calendar || res.data.results || res.data;
  const dayMap = {};
  for (const day of calendar) {
    dayMap[day.date] = {
      price: day.price,
      minNights: day.minNights || day.minStay || day.minimumNights
    };
  }
  return dayMap;
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function buildDateRange(days = 3) {
  const start = new Date();
  const end = addDays(start, days - 1);
  return {
    startDate: formatDate(start),
    endDate: formatDate(end)
  };
}

app.get("/", (req, res) => {
  res.send(`<h2>Read Only Multi Calendar</h2>
    <a href="/calendar">VIEW CALENDAR</a>`);
});

app.get("/calendar", async (req, res) => {
  try {
    const { startDate, endDate } = buildDateRange(3);
    const token = await getAccessToken();

    // Build date array
    const dates = [];
    let cursor = new Date(startDate);
    const last = new Date(endDate);
    while (cursor <= last) {
      dates.push(formatDate(cursor));
      cursor = addDays(cursor, 1);
    }

    // Fetch listing info and calendar data for each listing, one at a time
    const listingsData = [];
    for (const listingId of TEST_LISTINGS) {
      let title = listingId;
      try {
        const info = await guestyGetListingInfo(listingId, token);
        title = info.title || info.nickname || listingId;
      } catch (e) {
        // fallback to ID if error
      }
      let calendar = {};
      try {
        calendar = await guestyGetCalendar(listingId, startDate, endDate, token);
      } catch (e) {
        // leave calendar empty if error
      }
      listingsData.push({ id: listingId, title, calendar });
      await sleep(10000); // 10 second between requests
    }

    // Build HTML table
    let html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Read Only Multi Calendar</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h2 { margin-bottom: 16px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: top; }
          th:first-child, td:first-child { text-align: left; min-width: 220px; }
          th { background: #f5f5f5; }
          .price { font-weight: bold; }
          .minstay { color: #666; font-size: 12px; margin-top: 4px; }
        </style>
      </head>
      <body>
        <h2>Read Only Multi Calendar</h2>
        <a href="/">HOME</a> &nbsp; <a href="/calendar">VIEW CALENDAR</a>
        <div>Dates: ${startDate} to ${endDate}</div>
        <br/>
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
                  const cell = listing.calendar[date] || {};
                  return `
                    <td>
                      <div class="price">${cell.price !== undefined ? `$${cell.price}` : "-"}</div>
                      <div class="minstay">${cell.minNights !== undefined ? `min ${cell.minNights}` : ""}</div>
                    </td>
                  `;
                }).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </body>
      </html>
    `;

    res.send(html);
  } catch (e) {
    res.status(500).send(`<pre>${e.message}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

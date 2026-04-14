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
let isActive = false;

let calendarCache = {
  key: null,
  data: null,
  expiresAt: 0
};

async function getAccessToken() {
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await axios.post(
    "https://open-api.guesty.com/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "open-api"
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.GUESTY_CLIENT_ID +
            ":" +
            process.env.GUESTY_CLIENT_SECRET
          ).toString("base64")
      }
    }
  );

  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;

  return cachedToken;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function guestyGetWithRetry(url, config = {}, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      const status = e.response?.status;

      if (status !== 429 || attempt === retries) {
        throw e;
      }

      const retryAfterHeader = e.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : 5000;

      console.log("RATE LIMITED WAIT:", retryAfterMs);
      await sleep(retryAfterMs);
    }
  }
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

async function getListingsInfo(token) {
  const out = [];

  for (const id of TEST_LISTINGS) {
    try {
      const res = await guestyGetWithRetry(
        `https://open-api.guesty.com/v1/listings/${id}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json"
          }
        }
      );

      out.push({
        id,
        title: res.data?.title || id
      });
    } catch (e) {
      console.log("LISTING INFO ERROR:", id, e.response?.data || e.message);
      out.push({
        id,
        title: id
      });
    }

    await sleep(1500);
  }

  return out;
}

async function getMultiCalendar(token, startDate, endDate) {
  const cacheKey = `${startDate}_${endDate}_${TEST_LISTINGS.join(",")}`;

  if (
    calendarCache.key === cacheKey &&
    calendarCache.data &&
    Date.now() < calendarCache.expiresAt
  ) {
    console.log("USING CACHED CALENDAR");
    return calendarCache.data;
  }

  const results = [];

  for (const listingId of TEST_LISTINGS) {
    console.log("FETCHING:", listingId);

    try {
      const res = await guestyGetWithRetry(
        `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/minified/${listingId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json"
          },
          params: {
            from: startDate,
            to: endDate,
            view: "compact"
          }
        }
      );

      console.log(
        `RAW FOR ${listingId}:`,
        JSON.stringify(res.data, null, 2)
      );

      results.push({
        listingId,
        raw: res.data,
        calendar:
          res.data?.calendar ||
          res.data?.days ||
          res.data?.results ||
          res.data?.data ||
          res.data?.dates ||
          []
      });
    } catch (e) {
      console.log("ERROR LISTING:", listingId, e.response?.data || e.message);
      results.push({
        listingId,
        raw: null,
        calendar: []
      });
    }

    await sleep(3000);
  }

  calendarCache = {
    key: cacheKey,
    data: results,
    expiresAt: Date.now() + 5 * 60 * 1000
  };

  return results;
}

function collectDayMap(rawData) {
  const map = {};

  for (const item of rawData) {
    const listingId = item.listingId;
    const days = Array.isArray(item.calendar) ? item.calendar : [];

    map[listingId] = {};

    for (const day of days) {
      const date =
        day.date ||
        day.day ||
        day._id ||
        day.calendarDate ||
        "";

      if (!date) continue;

      const price =
        day.price ??
        day.basePrice ??
        day.adjustedPrice ??
        day.rate ??
        day.nightlyRate ??
        day.calendarPrice ??
        day.rates?.baseRate ??
        day.rates?.adjustedPrice ??
        day.rates?.nightlyRate ??
        day.p ??
        "";

      const minStay =
        day.minNights ??
        day.minStay ??
        day.minimumNights ??
        day.minBookedDays ??
        "";

      const status =
        day.status ??
        day.available ??
        day.availability ??
        "";

      map[listingId][date] = {
        price,
        minStay,
        status
      };
    }
  }

  return map;
}

app.get("/", (req, res) => {
  res.send(`
    <h2>Guesty Pricing Bot</h2>
    <a href="/on">TURN ON</a><br/><br/>
    <a href="/off">TURN OFF</a><br/><br/>
    <a href="/debug">DEBUG</a><br/><br/>
    <a href="/calendar">VIEW CALENDAR</a>
  `);
});

app.get("/on", (req, res) => {
  isActive = true;
  res.send("ON");
});

app.get("/off", (req, res) => {
  isActive = false;
  res.send("OFF");
});

app.get("/debug", (req, res) => {
  res.json({
    isActive,
    TEST_LISTINGS,
    cacheExpiresAt: calendarCache.expiresAt
  });
});

app.get("/calendar", async (req, res) => {
  try {
    const token = await getAccessToken();
    const { startDate, endDate } = buildDateRange(3);

    const [listingInfo, rawCalendar] = await Promise.all([
      getListingsInfo(token),
      getMultiCalendar(token, startDate, endDate)
    ]);

    const dayMap = collectDayMap(rawCalendar);

    const dates = [];
    let cursor = new Date(startDate);
    const last = new Date(endDate);

    while (cursor <= last) {
      dates.push(formatDate(cursor));
      cursor = addDays(cursor, 1);
    }

    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Read Only Multi Calendar</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: top; }
          th:first-child, td:first-child { text-align: left; min-width: 220px; }
          th { background: #f5f5f5; }
          .price { font-weight: bold; font-size: 16px; }
          .minstay { color: #666; font-size: 12px; margin-top: 4px; }
          .status { color: #999; font-size: 12px; margin-top: 4px; }
          .wrap { overflow-x: auto; }
          a { margin-right: 12px; }
        </style>
      </head>
      <body>
        <h2>Read Only Multi Calendar</h2>
        <div>
          <a href="/">HOME</a>
          <a href="/calendar">VIEW CALENDAR</a>
        </div>
        <br/>
        <div>Dates: ${startDate} to ${endDate}</div>
        <br/>
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>Listing</th>
                ${dates.map(d => `<th>${d.slice(5)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${listingInfo.map(listing => `
                <tr>
                  <td>
                    <div><strong>${listing.title}</strong></div>
                    <div>${listing.id}</div>
                  </td>
                  ${dates.map(date => {
                    const cell = dayMap[listing.id]?.[date] || {};
                    return `
                      <td>
                        <div class="price">${cell.price !== "" ? `$${cell.price}` : "-"}</div>
                        <div class="minstay">${cell.minStay !== "" ? `min ${cell.minStay}` : ""}</div>
                        <div class="status">${cell.status !== "" ? String(cell.status) : ""}</div>
                      </td>
                    `;
                  }).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (e) {
    res.status(500).send(`
      <pre>${String(e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message)}</pre>
    `);
  }
});

app.listen(PORT, () => {
  console.log("Pricing bot running - read only calendar mode");
});

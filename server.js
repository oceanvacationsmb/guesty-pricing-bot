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

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

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

async function getListingsInfo(token) {
  const out = [];

  for (const id of TEST_LISTINGS) {
    try {
      const res = await axios.get(
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
      out.push({
        id,
        title: id
      });
      console.log("LISTING INFO ERROR", id, e.response?.data || e.message);
    }
  }

  return out;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function guestyGetWithRetry(url, config = {}, retries = 5) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      if (i === retries) throw e;

      const wait = 2000 * (i + 1);
      console.log("RATE LIMITED - WAIT", wait);
      await sleep(wait);
    }
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getMultiCalendar(token, startDate, endDate) {
  const results = [];

  for (const listingId of TEST_LISTINGS) {

    console.log("FETCHING:", listingId);

    try {
      const res = await axios.get(
        `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings/${listingId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json"
          },
          params: {
            from: startDate,
            to: endDate
          }
        }
      );

      results.push({
        listingId,
        calendar: res.data?.calendar || res.data?.results || res.data
      });

    } catch (e) {
      console.log("ERROR LISTING:", listingId, e.response?.data || e.message);
    }

    await sleep(3000);
  }

  console.log("CALENDAR RAW:", JSON.stringify(results, null, 2));

  return results;
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

function buildDateRange(days = 14) {
  const start = new Date();
  const end = addDays(start, days - 1);
  return {
    startDate: formatDate(start),
    endDate: formatDate(end)
  };
}

function collectDayMap(rawData) {
  console.log("RAW CALENDAR RESPONSE:", JSON.stringify(rawData, null, 2));

  const map = {};

  const listings = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.results)
      ? rawData.results
      : Array.isArray(rawData?.data)
        ? rawData.data
        : [];

  for (const item of listings) {
    const listingId =
      item.listingId ||
      item._id ||
      item.id ||
      item.listing?._id ||
      item.listing?.id;

    const days =
      item.calendar ||
      item.days ||
      item.results ||
      item.data ||
      item.dates ||
      [];

    map[listingId] = {};

    for (const day of days) {
      const date =
        day.date ||
        day.day ||
        day._id;

      if (!date) continue;

      const price =
        day.price ??
        day.basePrice ??
        day.adjustedPrice ??
        day.rate ??
        day.nightlyRate ??
        day.rates?.baseRate ??
        day.rates?.adjustedPrice ??
        day.rates?.nightlyRate ??
        day.calendarPrice ??
        "";

      map[listingId][date] = {
        price,
        minStay:
          day.minNights ??
          day.minStay ??
          day.minimumNights ??
          "",
        status:
          day.status ??
          day.available ??
          ""
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
    <a href="/calendar">VIEW MULTI CALENDAR</a>
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
    TEST_LISTINGS
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
        <title>Multi Calendar</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h2 { margin-bottom: 16px; }
          .topbar { margin-bottom: 16px; }
          .topbar a { margin-right: 14px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: top; }
          th:first-child, td:first-child { text-align: left; position: sticky; left: 0; background: #fff; min-width: 220px; }
          th { background: #f5f5f5; }
          .price { font-weight: bold; }
          .minstay { color: #666; font-size: 12px; margin-top: 4px; }
          .status { color: #999; font-size: 12px; margin-top: 4px; }
          .wrap { overflow-x: auto; }
        </style>
      </head>
      <body>
        <h2>Read Only Multi Calendar</h2>
        <div class="topbar">
          <a href="/">HOME</a>
          <a href="/calendar">REFRESH</a>
        </div>
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
                        <div class="price">${cell.price ? `$${cell.price}` : "-"}</div>
                        <div class="minstay">${cell.minStay ? `min ${cell.minStay}` : ""}</div>
                        <div class="status">${cell.status || ""}</div>
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
  console.log("Pricing bot running - read only multi calendar");
});

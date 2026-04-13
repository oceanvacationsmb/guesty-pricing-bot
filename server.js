import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== TEST LISTINGS (ONLY THESE WILL RUN) =====
const TEST_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d",
  "69db0826f579c50013546169"
];

// ===== TOKEN CACHE =====
let cachedToken = null;
let tokenExpiresAt = null;

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

// ===== GET REAL CALENDAR PRICE =====
async function getCalendarPrice(listingId, date, token) {
  try {
    const res = await axios.get(
      "https://open-api.guesty.com/v1/calendar",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          listingId: listingId,
          startDate: date,
          endDate: date
        }
      }
    );

    return res.data?.results?.[0]?.price || 0;

  } catch (e) {
    console.log("PRICE ERROR", listingId, date, e.response?.data || "");
    return 0;
  }
}

// ===== STORAGE =====
let snapshots = {};
let isActive = false;

// ===== UI PAGE =====
app.get("/", (req, res) => {
  res.send(`
    <h2>Pricing Bot</h2>
    <a href="/on">TURN ON</a><br/><br/>
    <a href="/off">TURN OFF</a><br/><br/>
    <a href="/run">RUN</a><br/><br/>
    <a href="/debug">DEBUG</a>
  `);
});

// ===== DEBUG =====
app.get("/debug", (req, res) => {
  res.json({
    isActive,
    TEST_LISTINGS,
    snapshots
  });
});

// ===== TURN ON =====
app.get("/on", (req, res) => {
  isActive = true;
  res.send("ON");
});

// ===== TURN OFF =====
app.get("/off", (req, res) => {
  isActive = false;
  res.send("OFF");
});

// ===== RUN =====
app.get("/run", async (req, res) => {

  if (!isActive) {
    return res.send("NOT ACTIVE - CLICK TURN ON FIRST");
  }

  const token = await getAccessToken();
  const today = new Date();

  for (const listingId of TEST_LISTINGS) {

    for (let i = 0; i < 30; i++) {

      const d = new Date();
      d.setDate(today.getDate() + i);
      const dateStr = d.toISOString().split("T")[0];

      // ===== GET REAL PRICE =====
      const basePrice = await getCalendarPrice(listingId, dateStr, token);

      if (!basePrice) continue;

      // ===== SAVE ORIGINAL (ONCE) =====
      if (!snapshots[listingId]) snapshots[listingId] = {};

      if (!snapshots[listingId][dateStr]) {
        snapshots[listingId][dateStr] = {
          original: basePrice
        };
      }

      let price = basePrice;

      // ===== STRATEGY =====
      if (i <= 7) price *= 0.8;
      else if (i <= 14) price *= 0.85;
      else if (i <= 21) price *= 0.9;
      else price *= 0.95;

      price = Math.round(price);

      console.log(
        "TEST UPDATE:",
        listingId,
        dateStr,
        "ORIGINAL:",
        basePrice,
        "NEW:",
        price
      );
    }
  }

  res.send("RUN COMPLETE - CHECK LOGS");
});

// ===== START =====
app.listen(PORT, () => {
  console.log("Pricing bot running (REAL PRICE TEST MODE)");
});

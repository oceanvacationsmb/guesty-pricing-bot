import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ================= TEST MODE =================
const TEST_MODE = true;
const TEST_LISTINGS = [
  "PUT_LISTING_ID_1",
  "PUT_LISTING_ID_2"
];

// ================= TOKEN CACHE =================
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

// ================= STORAGE =================
let selectedListings = [];
let strategies = {};
let snapshots = {};
let isActive = false;

// ================= GET LISTINGS =================
app.get("/listings", async (req, res) => {
  const token = await getAccessToken();

  const response = await axios.get(
    "https://open-api.guesty.com/v1/listings",
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200 }
    }
  );

  res.json(response.data);
});

// ================= SELECT =================
app.post("/listings/select", (req, res) => {
  selectedListings = req.body.listings;
  res.json({ success: true });
});

// ================= STRATEGY =================
app.post("/strategy", (req, res) => {
  const { listingId, config } = req.body;
  strategies[listingId] = config;
  res.json({ success: true });
});

// ================= TOGGLE =================
app.post("/toggle", (req, res) => {
  isActive = req.body.active;
  res.json({ active: isActive });
});

// ================= RUN =================
app.post("/run", async (req, res) => {
  if (!isActive) return res.json({ message: "inactive" });

  const listingsToRun = TEST_MODE ? TEST_LISTINGS : selectedListings;

  for (const listingId of listingsToRun) {

    const strategy = strategies[listingId] || { min: 50, max: 500 };

    const today = new Date();

    for (let i = 0; i < 30; i++) {

      const d = new Date();
      d.setDate(today.getDate() + i);
      const dateStr = d.toISOString().split("T")[0];

      const basePrice = 200;

      if (!snapshots[listingId]) snapshots[listingId] = {};

      if (!snapshots[listingId][dateStr]) {
        snapshots[listingId][dateStr] = {
          original: basePrice
        };
      }

      let price = basePrice;

      if (i <= 7) price *= 0.8;
      else if (i <= 14) price *= 0.85;
      else if (i <= 21) price *= 0.9;
      else price *= 0.95;

      if (price < strategy.min) price = strategy.min;
      if (price > strategy.max) price = strategy.max;

      console.log("TEST UPDATE:", listingId, dateStr, Math.round(price));
    }
  }

  res.json({ success: true, testMode: true });
});

// ================= RESTORE =================
app.post("/restore", async (req, res) => {

  for (const listingId in snapshots) {
    for (const date in snapshots[listingId]) {

      const original = snapshots[listingId][date].original;

      console.log("RESTORE TEST:", listingId, date, original);
    }
  }

  res.json({ restored: true, testMode: true });
});

// ================= DEBUG =================
app.get("/debug", (req, res) => {
  res.json({
    selectedListings,
    strategies,
    snapshots,
    isActive,
    TEST_MODE,
    TEST_LISTINGS
  });
});

// ================= START =================
app.listen(PORT, () => {
  console.log("Pricing bot running (TEST MODE)");
});

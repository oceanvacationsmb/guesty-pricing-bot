import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== TEST MODE =====
const TEST_MODE = true;
const TEST_LISTINGS = [
  "PUT_REAL_LISTING_ID_1",
  "PUT_REAL_LISTING_ID_2"
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

// ===== STORAGE =====
let selectedListings = [];
let strategies = {};
let snapshots = {};
let isActive = false;

// ===== ROOT =====
app.get("/", (req, res) => {
  res.send("Pricing bot running");
});

// ===== DEBUG =====
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

// ===== TOGGLE =====
app.post("/toggle", (req, res) => {
  isActive = req.body.active;
  res.json({ active: isActive });
});

// ===== RUN =====
app.post("/run", async (req, res) => {

  if (!isActive) {
    console.log("NOT ACTIVE");
    return res.json({ message: "inactive" });
  }

  const listingsToRun = TEST_MODE ? TEST_LISTINGS : selectedListings;

  console.log("RUNNING FOR:", listingsToRun);

  const today = new Date();

  for (const listingId of listingsToRun) {

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

      console.log("TEST UPDATE:", listingId, dateStr, Math.round(price));
    }
  }

  res.json({ success: true });
});

// ===== RESTORE =====
app.post("/restore", (req, res) => {

  for (const listingId in snapshots) {
    for (const date in snapshots[listingId]) {
      console.log("RESTORE TEST:", listingId, date, snapshots[listingId][date].original);
    }
  }

  res.json({ restored: true });
});

// ===== START =====
app.listen(PORT, () => {
  console.log("Pricing bot running (TEST MODE)");
});

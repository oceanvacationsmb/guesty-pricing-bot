const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

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

// Always get a fresh token or check expiration
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

// Guesty API GET with retry and rate limit handling
async function guestyGetWithRetry(url, config = {}, retries = 5) {
  for (let i = 0; i <= retries; i++) {
    try {
      const token = await getAccessToken();
      config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
      return await axios.get(url, config);
    } catch (e) {
      if (i === retries) throw e;

      let wait = 10000 * (i + 1); // 10s, 20s, 30s, ...
      if (e.response && e.response.status === 429) {
        const retryAfter = e.response.headers['retry-after'];
        wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000; // 60s default
        console.log(`429 Too Many Requests. Waiting ${wait / 1000}s`);
      } else {
        console.log(`Error: ${e.message}. Waiting ${wait / 1000}s`);
      }
      await sleep(wait);
    }
  }
}

// Example endpoint: get info for all test listings, one at a time
app.get("/listings", async (req, res) => {
  const results = [];
  for (const id of TEST_LISTINGS) {
    try {
      const response = await guestyGetWithRetry(
        `https://open-api.guesty.com/v1/listings/${id}`,
        { headers: { Accept: "application/json" } }
      );
      results.push({ id, data: response.data });
    } catch (e) {
      results.push({ id, error: e.message });
    }
    await sleep(10000); // 10 seconds between requests
  }
  res.json(results);
});

app.get("/", (req, res) => {
  res.send("Guesty API server is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

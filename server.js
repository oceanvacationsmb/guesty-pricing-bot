import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let MANAGED_LISTINGS = [
  "69db18d8085e450014e2bf65",
  "69db12c790763a00130d40bc",
  "69db12bff579c50013548a0d"
];
let LISTINGS_INFO = {};
let LISTINGS_STRATEGY = {};
let ORIGINAL_RATES = {};

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
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatDate(date) { return date.toISOString().split("T")[0]; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function buildDateRange(days = 14) {
  const start = new Date(), end = addDays(start, days-1);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}
function extractDays(calendarData) {
  if (Array.isArray(calendarData?.data?.days)) return calendarData.data.days;
  if (Array.isArray(calendarData?.days)) return calendarData.days;
  if (Array.isArray(calendarData?.data)) return calendarData.data;
  if (Array.isArray(calendarData?.results)) return calendarData.results;
  if (Array.isArray(calendarData)) return calendarData; return [];
}
function getDayPrice(day) {
  return (day.price ?? day.p ?? day.basePrice ?? day.adjustedPrice ?? day.rate ??
    day.nightlyRate ?? day.calendarPrice ?? day.rates?.baseRate ??
    day.rates?.adjustedPrice ?? day.rates?.nightlyRate);
}
function getDayMinNights(day) {
  return (day.minNights ?? day.m ?? day.minStay ?? day.minimumNights);
}
function getDayStatus(day) {
  if (day.type === "block") return "BLOCK";
  if (day.reservationId || day.type === "reservation") return "BOOKED";
  return "AVAILABLE";
}

async function guestyApiGet(url, config = {}, retries = 5) {
  for (let i=0;i<retries;i++) try {
    return await axios.get(url, config);
  } catch (e) {
    if (e.response?.status === 429) {
      await sleep((parseInt(e.response.headers["retry-after"],10)||60)*1000); continue;
    }
    throw e;
  }
  throw new Error("Too many retries");
}
async function guestyGetListingInfo(listingId, token) {
  const url = `https://open-api.guesty.com/v1/listings/${listingId}`;
  const res = await guestyApiGet(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}
async function guestyGetBatchCalendar(listingIds, startDate, endDate, token) {
  const url = "https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings";
  const res = await guestyApiGet(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      listingIds: listingIds.join(","),
      startDate, endDate,
      ignoreInactiveChildAllotment: true,
      useChildValues: true,
      includeReservations: true, includeBlocks: true
    }
  });
  return res.data;
}
async function guestyUpdateCalendarDate(listingId, date, valueObj, token) {
  const url = `https://open-api.guesty.com/v1/availability-pricing/api/calendar/listing/${listingId}/day/${date}`;
  await axios.patch(url, valueObj, { headers: { Authorization: `Bearer ${token}` } });
}

// --------- API: List/Manage ---------
app.get("/api/listings", (req,res) => res.json({listings: MANAGED_LISTINGS}));
app.post("/api/listings", (req,res) => {
  const { id } = req.body; if (!id || typeof id !== "string" || MANAGED_LISTINGS.includes(id)) {
    return res.status(400).json({ error: "Invalid or duplicate listing ID" });
  } MANAGED_LISTINGS.push(id); res.json({ listings: MANAGED_LISTINGS });
});
app.delete("/api/listings/:id", (req,res) => {
  const { id } = req.params;
  MANAGED_LISTINGS = MANAGED_LISTINGS.filter(lid => lid!==id);
  delete LISTINGS_STRATEGY[id]; delete LISTINGS_INFO[id]; delete ORIGINAL_RATES[id];
  res.json({listings: MANAGED_LISTINGS});
});
app.get("/api/strategy/:id", (req,res) => {
  res.json({ strategy: LISTINGS_STRATEGY[req.params.id] || {
    minRate: "", maxRate: "", minNights: "", weekendPct: "", weekdayPct: "",
    drop_0_7:"",drop_8_14:"",drop_15_21:"",drop_22_30:"",
    monthRules: [], rangeRules: [], eventRules: [], syncEnabled: true
  } });
});
app.post("/api/strategy/:id", (req,res) => {
  const s = req.body;
  if (!Array.isArray(s.monthRules)) s.monthRules = [];
  if (!Array.isArray(s.rangeRules)) s.rangeRules = [];
  if (!Array.isArray(s.eventRules)) s.eventRules = [];
  s.syncEnabled = s.syncEnabled!==undefined?s.syncEnabled:true;
  LISTINGS_STRATEGY[req.params.id] = s;
  res.json({ok: true});
});
app.post("/api/clone-strategy", (req,res) => {
  const { fromId, toIds } = req.body;
  if (!fromId || !Array.isArray(toIds)) return res.status(400).json({error:"Invalid"});
  for (const tid of toIds) {
    if (fromId===tid) continue;
    const _copy = JSON.parse(JSON.stringify(LISTINGS_STRATEGY[fromId]||{}));
    LISTINGS_STRATEGY[tid] = _copy;
  }
  res.json({ok:true});
});

function rateRuleForDate(strategy, dateStr) {
  const dt = new Date(dateStr);
  for (const e of (strategy.eventRules||[])) {
    if (!e.enabled) continue;
    if (e.annual) {
      const [sy,sm,sd]=e.start.split("-"), [ey,em,ed]=e.end.split("-");
      const dmonth = (dt.getMonth()+1).toString().padStart(2,'0');
      const dday = dt.getDate().toString().padStart(2,'0');
      if ((dmonth+dday >= sm+sd && dmonth+dday <= em+ed)) return {src:"event", ...e};
    } else if (dateStr>=e.start && dateStr<=e.end) return {src:"event", ...e};
  }
  for (const r of (strategy.rangeRules||[])) {
    if (!r.enabled) continue;
    if (dateStr>=r.start && dateStr<=r.end) return {src:"range", ...r};
  }
  for (const m of (strategy.monthRules||[])) {
    if (!m.enabled) continue;
    if ((dt.getMonth()+1)==parseInt(m.month,10)) return {src:"month", ...m};
  }
  return null;
}

async function applyAutomationForListing(listingId, daysArr, strategy, token) {
  if (!strategy.syncEnabled) return;
  if (!ORIGINAL_RATES[listingId]) ORIGINAL_RATES[listingId] = {};
  for (const day of daysArr) {
    const theDate = day.date||day.day||day.calendarDate;
    const stat = getDayStatus(day); if (stat!=="AVAILABLE") continue;
    if (!ORIGINAL_RATES[listingId][theDate]) {
      ORIGINAL_RATES[listingId][theDate] = {
        price: getDayPrice(day)||null, minNights: getDayMinNights(day)||null
      };
    }
    let origPrice = ORIGINAL_RATES[listingId][theDate].price ?? getDayPrice(day);
    let adjPrice = origPrice;
    const special = rateRuleForDate(strategy, theDate);
    if (special && special.base) adjPrice = parseFloat(special.base)||origPrice;
    let daysAway = Math.ceil((new Date(theDate) - new Date())/(1000*60*60*24));
    daysAway = Math.max(daysAway,0);
    if (!special) {
      if (daysAway<=7&&strategy.drop_0_7) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_0_7)||0)/100));
      else if (daysAway<=14&&strategy.drop_8_14) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_8_14)||0)/100));
      else if (daysAway<=21&&strategy.drop_15_21) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_15_21)||0)/100));
      else if (daysAway<=30&&strategy.drop_22_30) adjPrice=Math.round(origPrice*(1-(parseFloat(strategy.drop_22_30)||0)/100));
      if (strategy.weekendPct && [0,6].includes(new Date(theDate).getDay())) adjPrice = Math.round(origPrice*(1+(parseFloat(strategy.weekendPct)||0)/100));
      if (strategy.weekdayPct && ![0,6].includes(new Date(theDate).getDay())) adjPrice = Math.round(origPrice*(1-(parseFloat(strategy.weekdayPct)||0)/100));
      if (strategy.minRate) adjPrice = Math.max(adjPrice, parseFloat(strategy.minRate));
      if (strategy.maxRate) adjPrice = Math.min(adjPrice, parseFloat(strategy.maxRate));
    }
    if (adjPrice !== getDayPrice(day)) {
      try { await guestyUpdateCalendarDate(listingId, theDate, {price: adjPrice}, token); day.price = adjPrice; }
      catch{}
    }
    let minN = special && special.minNights ? parseInt(special.minNights) : (strategy.minNights ? parseInt(strategy.minNights):undefined);
    if (minN && day.minNights>minN) {
      try { await guestyUpdateCalendarDate(listingId, theDate, {minNights:minN}, token); day.minNights = minN;} catch{}
    }
  }
}

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/dashboard.html");
});

app.post("/calendar-table", async (req,res)=>{
  try {
    const { listingIds } = req.body;
    if (!listingIds||!Array.isArray(listingIds)||!listingIds.length) return res.send("<b>No properties to show.</b>");
    const { startDate, endDate } = buildDateRange(14);
    const token = await getAccessToken();
    const dates=[],last=new Date(endDate);let cursor=new Date(startDate);
    while (cursor<=last) { dates.push(formatDate(cursor)); cursor=addDays(cursor,1);}
    let listingsData=[];
    for (const listingId of listingIds) {
      let title=listingId, daysArr=[];
      try {
        const info = await guestyGetListingInfo(listingId, token);
        title = info.title||info.nickname||listingId; LISTINGS_INFO[listingId]=info;
      }catch{}
      let cal={};
      try { cal = await guestyGetBatchCalendar([listingId],startDate,endDate,token);}catch{}
      const days = extractDays(cal);
      const strategy = LISTINGS_STRATEGY[listingId]||{syncEnabled:true};
      await applyAutomationForListing(listingId,days,strategy,token);
      listingsData.push({id:listingId,title,days});
      await sleep(350);
    }
    const tableHtml = `
      <div>Dates: ${startDate} to ${endDate}</div>
      <table><thead><tr>
      <th>Listing</th>${dates.map(d=>`<th>${d.slice(5)}</th>`).join("")}
      </tr></thead><tbody>
      ${listingsData.map(listing=>`
        <tr>
        <td>
          <div><strong>${listing.title}</strong></div><div>${listing.id}</div>
        </td>
        ${dates.map(date=>{
          const day = listing.days.find(x=>(x.date||x.day||x.calendarDate)===date)||{};
          const stat = getDayStatus(day);
          if (stat==="BLOCK") return '<td class="stat-block">NOT AVAILABLE</td>';
          if (stat==="BOOKED") return '<td class="stat-booked">BOOKED</td>';
          const orig = (ORIGINAL_RATES[listing.id]||{})[date]?.price??getDayPrice(day);
          const minN = day.minNights??"";
          return `<td>
            <div class="orig-rate">Original: $${orig||""}</div>
            <div class="price">Adjusted: $${getDayPrice(day)||""}</div>
            <div class="minstay">Min nights: ${minN!==""?minN:"-"}</div>
          </td>`;
        }).join("")}
        </tr>
      `).join("")}
      </tbody></table>
    `; res.send(tableHtml);
  } catch (e) {
    res.send("<pre>"+(e.response?.data?JSON.stringify(e.response.data,null,2):e.message)+"</pre>");
  }
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));

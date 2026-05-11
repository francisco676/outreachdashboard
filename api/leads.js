// /api/leads.js
// Fetches all entries from the Outreach Pipeline list in Attio.
// Uses Vercel KV (Upstash Redis) as a shared cache, refreshed daily by cron.
//
// Request flow:
//   1. Frontend hits /api/leads → check KV cache → return cached payload (instant)
//   2. Frontend hits /api/leads?fresh=1 → bypass cache, fetch from Attio, update KV
//   3. Vercel cron hits /api/leads (with vercel-cron user-agent) → forces fresh fetch
//
// If KV env vars are missing, the function still works but every request hits Attio.

const ATTIO_API_KEY = process.env.ATTIO_API_KEY;
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const CACHE_KEY = "outreach_leads_v1";
const CACHE_TTL_SECONDS = 25 * 60 * 60; // 25h, slightly longer than daily cron interval

export default async function handler(req, res) {
  if (!ATTIO_API_KEY) {
    return res.status(500).json({
      error: "ATTIO_API_KEY env var not configured. Set it in Vercel project settings."
    });
  }

  const isCron = (req.headers["user-agent"] || "").includes("vercel-cron");
  const forceRefresh = isCron || req.query.fresh === "1";

  // 1. Try cache (unless forced)
  if (!forceRefresh && KV_URL && KV_TOKEN) {
    try {
      const cached = await kvGet(CACHE_KEY);
      if (cached) {
        return res.status(200).json({ ...cached, cache: "hit" });
      }
    } catch (e) {
      console.error("cache read failed:", e.message);
      // fall through to Attio fetch
    }
  }

  // 2. Fetch fresh from Attio
  try {
    const entries = await fetchFromAttio();
    const payload = {
      entries,
      timestamp: new Date().toISOString(),
      count: entries.length
    };

    // 3. Write to cache (best effort, don't block response)
    if (KV_URL && KV_TOKEN) {
      kvSet(CACHE_KEY, payload, CACHE_TTL_SECONDS).catch(e =>
        console.error("cache write failed:", e.message)
      );
    }

    return res.status(200).json({
      ...payload,
      cache: isCron ? "cron-refresh" : (forceRefresh ? "manual-refresh" : "miss")
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "unknown error" });
  }
}

// ---------- Attio ----------
async function fetchFromAttio() {
  const allEntries = [];
  let offset = 0;
  const limit = 500;

  for (let i = 0; i < 10; i++) {
    const response = await fetch(
      "https://api.attio.com/v2/lists/outreach_pipeline/entries/query",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ATTIO_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ limit, offset })
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Attio API ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const rawEntries = data.data || [];
    allEntries.push(...rawEntries.map(parseEntry));

    if (rawEntries.length < limit) break;
    offset += limit;
  }

  return allEntries;
}

function parseEntry(raw) {
  const v = raw.entry_values || {};
  return {
    entry_id: raw.id?.entry_id || null,
    stage: extractTitle(v.stage),
    lead_type: extractTitle(v.lead_type),
    format: extractTitle(v.format),
    owner_id: extractActorId(v.owner),
    outreach_date: extractValue(v.outreach_date),
    created_at: raw.created_at || null,
    sent: extractBool(v.sent),
    response: extractBool(v.response),
    meeting_booked: extractBool(v.meeting_booked),
    proposal_sent: extractBool(v.proposal_sent),
    rejected_not_a_fit: extractBool(v.rejected_not_a_fit)
  };
}

function extractTitle(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  return first?.status?.title || first?.option?.title || first?.value || null;
}

function extractActorId(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  return first?.referenced_actor_id || first?.workspace_member_id || null;
}

function extractValue(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.value || null;
}

function extractBool(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return !!arr[0]?.value;
}

// ---------- KV (Upstash REST API) ----------
async function kvGet(key) {
  const response = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!response.ok) throw new Error(`KV get ${response.status}`);
  const data = await response.json();
  if (!data.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function kvSet(key, value, ttlSeconds) {
  const response = await fetch(
    `${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "text/plain"
      },
      body: JSON.stringify(value)
    }
  );
  if (!response.ok) throw new Error(`KV set ${response.status}`);
}

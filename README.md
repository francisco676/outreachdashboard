# rallyup outreach performance dashboard

live dashboard tracking outreach pipeline performance for francisco and alec, fed directly from attio.

## architecture

```
                    daily 7am UTC
                         ↓
                  vercel cron job
                         ↓
                  /api/leads (forced fresh)
                         ↓
                   attio rest api
                         ↓
                  vercel kv (redis)
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
        francisco's              alec's
         browser                  browser
        (instant)                (instant)
```

both users share the same kv cache, so francisco's morning load warms it for alec, and the daily cron warms it before either of them opens it.

## what's inside

```
outreach-dashboard/
├── index.html          # the dashboard (single-file react app)
├── api/
│   └── leads.js        # serverless function: kv cache + attio fetch
├── vercel.json         # cron config (runs /api/leads at 7am UTC daily)
├── package.json
└── README.md
```

## deploy in 7 steps

### 1. push to github

```bash
cd outreach-dashboard
git init
git add .
git commit -m "outreach dashboard v1"
gh repo create rallyup-outreach-dashboard --private --source=. --push
```

### 2. get an attio api key

1. attio → settings → developers → api tokens
2. create token with these scopes:
   - `record_permission:read`
   - `list_entry:read`
   - `list_configuration:read`
3. copy the token

### 3. import to vercel

1. vercel.com/new
2. import the github repo
3. framework preset: "other"
4. don't deploy yet, click "environment variables" first
5. add `ATTIO_API_KEY=<your_attio_api_key>` (apply to all envs)
6. click deploy

vercel gives you a url like `rallyup-outreach-dashboard.vercel.app`. dashboard works now, but every load hits attio. let's fix that.

### 4. add vercel kv (free tier)

1. in vercel project → storage tab → create database
2. select "kv" (it's powered by upstash redis under the hood)
3. give it a name, pick a region close to you (e.g. iad1 for us-east, fra1 for europe)
4. click create
5. vercel auto-injects these env vars into the project:
   - `KV_URL` (or `UPSTASH_REDIS_REST_URL`)
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_TOKEN`)
6. redeploy the project for env vars to take effect (vercel → deployments → ⋮ → redeploy)

### 5. verify cron is registered

1. vercel project → settings → cron jobs
2. you should see one entry: `/api/leads` running daily at `0 7 * * *` (7am utc)
3. you can test it manually by clicking "trigger" next to the cron entry

### 6. (optional) add custom domain

1. vercel → project → settings → domains
2. add `outreach.rallyup.team`
3. point cname at `cname.vercel-dns.com` in your dns
4. ssl auto-issues in ~2 min

### 7. (recommended) lock it down

three options for restricting access:

**a. vercel password protection** (pro plan, easiest)
- vercel → project → settings → deployment protection → password protection
- set a shared password, send to alec

**b. vercel sso** (pro plan)
- only members of your vercel team can access

**c. cloudflare access** (free)
- put the deployed url behind cloudflare access with email-based auth
- restrict to your two work emails

without auth the security is just url obscurity. fine for two people who keep the link private.

## how the caching works

three request types:

| trigger | url | behavior |
|---------|-----|----------|
| user opens dashboard | `/api/leads` | reads from kv, returns instantly |
| user clicks refresh | `/api/leads?fresh=1` | bypasses kv, hits attio, updates kv |
| daily cron | `/api/leads` (with `vercel-cron` user-agent) | bypasses kv, hits attio, updates kv |

cache ttl is 25 hours (just longer than the cron interval), so even if cron fails one day, users still get cached data the next morning.

the dashboard header shows the cache status:
- `· cached` = served from kv
- `· auto-refreshed` = served by the cron job (fresh data)
- nothing shown = manual refresh just ran

## changing the cron schedule

edit `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/leads",
      "schedule": "0 7 * * *"
    }
  ]
}
```

cron format is standard 5-field. examples:
- `0 7 * * *` → 7am utc daily (current default, ~9am madrid)
- `0 */6 * * *` → every 6 hours
- `0 6,18 * * *` → 6am and 6pm utc (twice daily)

⚠️ vercel hobby plan limits cron frequency to once per day. for hourly/multi-daily, you need pro.

## local dev

```bash
npm install -g vercel
vercel dev
```

create a `.env.local` file with:

```
ATTIO_API_KEY=...
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

(grab those from vercel project → settings → environment variables → "..." → "show value")

## customization

config lives at the top of `index.html`:
- `FRANCISCO_ID` / `ALEC_ID` (workspace member uuids)
- `ACTIVE_STAGES`, `STAGE_ORDER`, `STAGE_CATEGORY` (pipeline stages)
- `C` (color tokens)

if you rename a stage in attio, update the constants. if you add a third teammate, add their uuid and add a new pill to the view selector.

## troubleshooting

**dashboard shows 0 leads**
- check vercel function logs: vercel → deployments → latest → functions → /api/leads
- most likely: `ATTIO_API_KEY` missing/expired
- second most likely: api key doesn't have read permission on outreach_pipeline list

**refresh button errors out**
- the error box shows the actual response from the api
- 401 = bad attio api key
- 403 = permission scope too narrow
- 404 = list slug renamed (it's hardcoded as "outreach_pipeline" in `api/leads.js`)

**stage names don't match**
- attio is case-sensitive. if you renamed "Booked a Call" to "Booked Call", update STAGE_ORDER and the *_STAGES sets in index.html

**cron not running**
- vercel → settings → cron jobs → check it's listed
- click "trigger" to test manually
- check function logs to see the cron execution

**cache not working**
- function logs will say "cache read failed" if kv is misconfigured
- verify `KV_REST_API_URL` and `KV_REST_API_TOKEN` are present in env vars
- make sure you redeployed after adding kv (env vars need a fresh deploy)

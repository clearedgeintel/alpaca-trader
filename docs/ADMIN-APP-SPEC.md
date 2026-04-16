# Admin App — Multi-Tenant SaaS for Alpaca Auto Trader

## Drop this file as CLAUDE.md in a new repo to bootstrap the admin app.

---

# CLAUDE.md

## What this project is

This is the **admin portal** for a multi-tenant SaaS that lets customers subscribe to and manage their own isolated instance of Alpaca Auto Trader — an AI-powered stock + crypto trading bot. Each tenant gets their own Node.js bot process, their own Postgres database, and their own subdomain. This admin app handles onboarding, billing, provisioning, and fleet management. **It never touches trading logic — that lives in the bot repo.**

## Architecture

```
┌────────────────────────────────────────────────┐
│              Admin Portal (this repo)           │
│  Next.js 14+ (App Router) + Tailwind + shadcn  │
│                                                 │
│  Auth:    Clerk (or Auth0)                      │
│  Billing: Stripe (subscriptions + webhooks)     │
│  DB:      Supabase Postgres (admin-only data)   │
│  Infra:   Railway API (or Fly.io Machines API)  │
│           to provision per-tenant bot instances  │
└────────────────┬───────────────────────────┬────┘
                 │                           │
    ┌────────────▼──────┐       ┌────────────▼──────┐
    │   Tenant A Bot    │       │   Tenant B Bot    │
    │  (Railway service)│       │  (Railway service)│
    │  Node.js + PG     │       │  Node.js + PG     │
    │  acme.trade.ai    │       │  beta.trade.ai    │
    └───────────────────┘       └───────────────────┘
```

## Tech Stack

- **Framework**: Next.js 14+ with App Router, TypeScript, Tailwind CSS, shadcn/ui
- **Auth**: Clerk (SSO, magic links, org support) — alternatives: Auth0, Supabase Auth
- **Billing**: Stripe Checkout + Subscriptions + Customer Portal + Webhooks
- **Admin DB**: Supabase Postgres — stores tenants, subscriptions, provisioning state
- **Provisioning**: Railway API (or Fly.io Machines API) — programmatic service creation
- **DNS**: Cloudflare API — wildcard subdomain routing to tenant instances

## Database Schema (admin DB — NOT the bot's DB)

```sql
-- Tenants
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,           -- used for subdomain: {slug}.yourdomain.com
  owner_id      TEXT NOT NULL,                  -- Clerk user ID
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | provisioning | active | paused | cancelled
  plan          TEXT NOT NULL DEFAULT 'starter', -- starter | pro | enterprise
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Stripe link
CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id  TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  status              TEXT NOT NULL DEFAULT 'incomplete', -- incomplete | active | past_due | cancelled
  current_period_end  TIMESTAMPTZ,
  plan                TEXT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- Per-tenant infrastructure state
CREATE TABLE tenant_infra (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  railway_service_id  TEXT,                      -- Railway service ID (or Fly machine ID)
  railway_env_id      TEXT,                      -- Railway environment ID
  database_url        TEXT,                      -- tenant's own Supabase Postgres URL
  subdomain           TEXT,                      -- full domain: acme.yourdomain.com
  bot_api_key         TEXT,                      -- the API_KEY we inject into the bot's .env
  health_status       TEXT DEFAULT 'unknown',    -- healthy | degraded | unhealthy | unknown
  last_health_check   TIMESTAMPTZ,
  provisioned_at      TIMESTAMPTZ,
  version             TEXT                       -- bot Docker image version/tag
);

-- Tenant credentials vault (encrypted at rest via Supabase RLS + column encryption)
CREATE TABLE tenant_secrets (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  alpaca_api_key      TEXT NOT NULL,             -- customer provides at onboarding
  alpaca_api_secret   TEXT NOT NULL,
  alpaca_base_url     TEXT DEFAULT 'https://paper-api.alpaca.markets',
  anthropic_api_key   TEXT,                      -- optional; shared key if null
  polygon_api_key     TEXT                       -- optional
);
```

## Onboarding Flow

```
1. Customer lands on marketing site → clicks "Start Trading"
2. Clerk sign-up (email/Google/GitHub)
3. Plan selection page (Starter $49/mo, Pro $149/mo, Enterprise $499/mo)
4. Stripe Checkout → payment confirmed via webhook
5. Onboarding wizard:
   a. Enter Alpaca API key + secret (paper or live)
   b. Choose initial watchlist (preset: Top 8, Crypto, Custom)
   c. Set risk tolerance (conservative / moderate / aggressive → maps to RISK_PCT)
   d. Choose agency mode (rules / hybrid / AI)
6. Admin API provisions:
   a. Creates a new Supabase project (or schema) for the tenant's bot DB
   b. Calls Railway API to create a new service from the bot template
   c. Injects env vars: ALPACA_API_KEY, ALPACA_API_SECRET, DATABASE_URL,
      ANTHROPIC_API_KEY, API_KEY (generated), PORT, USE_AGENCY, RISK_PCT, etc.
   d. Sets up subdomain via Cloudflare DNS API
   e. Waits for /api/health to return 200 → marks tenant as active
7. Customer redirected to {slug}.yourdomain.com — their bot is live
```

## Pages

```
/                          → Marketing / landing page
/sign-up                   → Clerk sign-up
/sign-in                   → Clerk sign-in
/onboarding                → Post-signup wizard (Alpaca keys, watchlist, risk, plan)
/dashboard                 → Tenant list (for users with multiple bots)
/dashboard/[tenantId]      → Tenant overview (health, P&L summary, quick actions)
/dashboard/[tenantId]/settings → Edit Alpaca keys, risk params, watchlist, plan
/dashboard/[tenantId]/billing  → Stripe Customer Portal embed
/admin                     → Internal admin panel (all tenants, health fleet view)
/admin/tenants             → Tenant list with status, plan, health, last active
/admin/tenants/[id]        → Single tenant detail (logs, config, manual actions)
/admin/metrics             → Fleet-wide Prometheus aggregation
```

## API Routes (Next.js Route Handlers)

```
POST /api/tenants                 → Create tenant + start provisioning
GET  /api/tenants                 → List tenants for current user
GET  /api/tenants/[id]            → Tenant detail + health proxy
PATCH /api/tenants/[id]           → Update settings (watchlist, risk, plan)
POST /api/tenants/[id]/pause      → Pause the bot (stop Railway service)
POST /api/tenants/[id]/resume     → Resume the bot
DELETE /api/tenants/[id]          → Cancel + deprovision

POST /api/webhooks/stripe         → Stripe webhook handler
  → subscription.created          → provision tenant infra
  → invoice.paid                  → mark active, extend period
  → invoice.payment_failed        → mark past_due, send warning
  → customer.subscription.deleted → pause bot, mark cancelled

POST /api/webhooks/clerk          → Clerk webhook (user created/deleted)

GET  /api/tenants/[id]/health     → Proxy to tenant's /api/health
GET  /api/tenants/[id]/account    → Proxy to tenant's /api/account
GET  /api/tenants/[id]/performance → Proxy to tenant's /api/performance
```

## Bot API Surface (what the admin app proxies to)

The bot (separate repo) exposes these endpoints that the admin app can proxy or link to:

**Health & Status:**
- `GET /api/health` — DB, Alpaca, LLM budget, agent heartbeats, .env age
- `GET /api/status` — market open/closed, uptime
- `GET /metrics` — Prometheus scrape (no auth required)

**Account & Trading:**
- `GET /api/account` — portfolio value, buying power, cash
- `GET /api/positions` — open positions
- `GET /api/trades` — all trades (paginated)
- `GET /api/performance` — daily P&L history

**Configuration (runtime, no restart):**
- `PUT /api/runtime-config/:key` — hot-reload RISK_PCT, STOP_PCT, TARGET_PCT, etc.
- `GET /api/config` — current effective config
- `PUT /api/strategies/:symbol` — per-symbol strategy override
- `PUT /api/strategies` — default strategy (rules/hybrid/llm)

**Bot API auth:** every bot instance has an `API_KEY` env var; admin app sends it as `x-api-key` header when proxying. The admin app generates a unique key per tenant at provisioning time.

## Subscription Plans

| Plan | Price | Limits | Features |
|------|-------|--------|----------|
| Starter | $49/mo | 1 bot, paper only, 8 symbols | Rules + hybrid mode |
| Pro | $149/mo | 1 bot, paper + live, 40 symbols, crypto | Full AI agency, all agents |
| Enterprise | $499/mo | 3 bots, priority support, custom prompts | Everything + prompt versioning + A/B |

Enforce limits:
- Symbol count: admin app sets MAX_SCAN_SYMBOLS env var at provision time
- Paper-only: admin app sets ALPACA_BASE_URL to paper endpoint; Settings page hides live toggle for Starter
- Bot count: admin DB query `WHERE owner_id = ? AND status != 'cancelled'`

## Provisioning (Railway API)

```typescript
// Pseudocode for the provisioning service

async function provisionTenant(tenant: Tenant, secrets: TenantSecrets) {
  // 1. Create a new Supabase project (or use schema isolation)
  const dbUrl = await supabase.createProject(tenant.slug);

  // 2. Create Railway service from template
  const service = await railway.createService({
    projectId: RAILWAY_PROJECT_ID,
    name: `bot-${tenant.slug}`,
    source: { image: `ghcr.io/your-org/alpaca-trader:latest` },
    variables: {
      ALPACA_API_KEY: secrets.alpaca_api_key,
      ALPACA_API_SECRET: secrets.alpaca_api_secret,
      ALPACA_BASE_URL: secrets.alpaca_base_url,
      DATABASE_URL: dbUrl,
      ANTHROPIC_API_KEY: secrets.anthropic_api_key || SHARED_ANTHROPIC_KEY,
      API_KEY: generateSecureToken(),
      USE_AGENCY: 'true',
      PORT: '3001',
      NODE_ENV: 'production',
      LLM_DAILY_COST_CAP_USD: planCostCap(tenant.plan),
    },
  });

  // 3. Set up custom domain
  await railway.addCustomDomain(service.id, `${tenant.slug}.yourdomain.com`);
  await cloudflare.addCNAME(tenant.slug, service.defaultDomain);

  // 4. Wait for healthy
  await pollUntilHealthy(`https://${tenant.slug}.yourdomain.com/api/health`, 120_000);

  // 5. Save infra state
  await db.tenantInfra.upsert({ tenantId: tenant.id, railwayServiceId: service.id, ... });
}
```

## Environment Variables (admin app)

```env
# Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
CLERK_WEBHOOK_SECRET=whsec_...

# Billing
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_STARTER_PRICE_ID=price_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_ENTERPRISE_PRICE_ID=price_...

# Admin DB
DATABASE_URL=postgresql://...

# Provisioning
RAILWAY_API_TOKEN=...
RAILWAY_PROJECT_ID=...
RAILWAY_TEMPLATE_ID=...       # template of the bot repo
SHARED_ANTHROPIC_KEY=...       # used for Starter plan tenants

# DNS
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
BASE_DOMAIN=yourdomain.com
```

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Run dev server (next dev)
npm run build        # Build for production
npm run db:push      # Push schema to Supabase (drizzle-kit push)
npm run db:migrate   # Run migrations
```

## Key Design Decisions

1. **Instance-per-tenant, not shared DB.** Trading involves real money — a tenant_id WHERE clause bug could leak positions or execute trades in the wrong account. Full isolation eliminates this risk class entirely.

2. **Bot repo is unchanged.** This admin app wraps the bot as a black box. The bot doesn't know it's part of a SaaS — it just reads its .env and runs. This means bot improvements ship to all tenants via image updates, and the admin app never needs to understand trading logic.

3. **Proxy, don't duplicate.** The admin app proxies to each tenant's bot API rather than reimplementing dashboards. The bot already has a full React UI at {slug}.yourdomain.com — the admin app links there for the trading experience and only surfaces summary data (health, P&L, account value) in its own dashboard.

4. **Stripe is the source of truth for subscription state.** Never trust client-side plan checks. The webhook handler is the single codepath that transitions tenant status.

5. **Secrets are stored encrypted and never logged.** Alpaca API keys are the most sensitive data in the system. Use Supabase column-level encryption or Vault for the tenant_secrets table. The admin UI shows masked versions only.

## Security Checklist

- [ ] Clerk middleware on all /dashboard and /api routes
- [ ] Stripe webhook signature verification
- [ ] Rate limiting on /api/tenants (prevent provisioning spam)
- [ ] tenant_secrets encrypted at rest
- [ ] Bot API_KEY generated with crypto.randomBytes(32)
- [ ] CORS locked to admin domain only
- [ ] No Alpaca keys in client-side code or logs
- [ ] RLS on Supabase: tenants.owner_id = auth.uid()

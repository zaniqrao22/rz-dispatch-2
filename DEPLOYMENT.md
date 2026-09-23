# Deployment guide

## 0) PostgreSQL (required)

The app now uses **PostgreSQL** instead of SQLite. Set a connection either via a full
connection string or individual variables:

```bash
PORT=8000
HOST=0.0.0.0
PUBLIC_URL=https://your-domain.com
JWT_SECRET=replace_with_a_secure_secret
ADMIN_EMAIL=admin@your-domain.com
ADMIN_PASSWORD=replace_with_a_strong_password
REQUIRE_LICENSE=true
APP_MODE=saas
LIFETIME_PRICE_CENTS=49900
LIFETIME_CURRENCY=usd
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Option A: full connection string (takes precedence over the PG* variables)
DATABASE_URL=postgresql://user:password@host:5432/rz_dispatch

# Option B: individual variables
PGHOST=your-db-host
PGPORT=5432
PGDATABASE=rz_dispatch
PGUSER=your-db-user
PGPASSWORD=your-db-password
# Set PGSSL=true for managed Postgres (Render/Railway/Fly.io/Supabase) which
# require an SSL connection:
PGSSL=true
```

Create the database first (e.g. `CREATE DATABASE rz_dispatch;`), then the app
creates the schema and seed data automatically on first start. To run it
explicitly, use `npm run db:init`.

### Moving existing SQLite data to PostgreSQL

If you were running the old SQLite version and want to keep its data:

1. Make sure your `DATABASE_URL` / `PG*` environment variables point at the
   target PostgreSQL database.
2. Stop the old app (so the SQLite file is not written to mid-copy).
3. Run `npm run db:migrate` — it reads `.data/rz_dispatch.db` and upserts every
   table into PostgreSQL (safe to re-run).

## 1) Production environment setup

## 2) Stripe configuration

1. Create a Stripe account and switch to live mode.
2. Add a product priced at $499.00.
3. Configure a webhook for `https://your-domain.com/api/payments/webhook`.
4. Subscribe to the `checkout.session.completed` event.
5. Paste the live webhook secret into `STRIPE_WEBHOOK_SECRET`.

## 3) Email verification setup

This app includes a JWT-based verification helper for email confirmation. For production, replace the placeholder flow with a real email service such as Resend, SendGrid, or Postmark.

Recommended flow:

- create a user
- send verification email with the token returned from `/api/auth/verify-email`
- call `/api/auth/verify-email/:token` to confirm ownership

## 4) Hosting recommendation

Recommended deployment stack:

- Host: Render, Railway, Fly.io, or VPS
- Reverse proxy: Nginx or built-in PaaS load balancer
- SSL: automatic HTTPS via the host
- Database: PostgreSQL (managed instance on the hosting provider, or a VPS install)
- Backups: schedule regular PostgreSQL backups (`pg_dump`)

## 5) Production checklist

- set real JWT secret
- use HTTPS everywhere
- disable demo accounts in production
- store secrets in environment variables only
- configure Stripe webhooks and test them
- verify license activation path end-to-end
- enable admin-only billing views
- review access control before opening the SaaS to customers

# RZ Dispatch — Fleet Operations Dashboard

One-time-purchase fleet operations software. Dispatch jobs, manage drivers and vehicles, run a booking + quote engine, track customers in a CRM, and give drivers and customers their own portals — all from a self-hosted dashboard with no monthly fees.

Stack: **Node.js (Express 5) · PostgreSQL · vanilla JavaScript · Stripe Checkout**

---

## Features

- **Live dispatch dashboard** — job queue, map view, fleet activity, ETAs, one-click driver assignment
- **Schedule board** — scroll forward/backward by day, every day shows its own jobs
- **Booking & quote engine** — instant estimates with per-service vehicle tiers (car / SUV / van / luxury), miles, passengers, hours
- **Customer portal** — public lookup that returns a customer's quotes and bookings by phone or ID
- **Customer CRM** — directory of contacts with order history and relationship view
- **Operator / driver portal** — status updates on jobs
- **Fleet, drivers, services, coverage zones** — full configuration screens
- **Analytics** — on-time rate, completed trips, utilization, ETA trends
- **Inbox + notifications** — activity feed with read/unread state
- **Authentication & roles** — admin, dispatcher, operator, customer; JWT sessions
- **Stripe licensing layer** — sell lifetime access or subscriptions; license keys activate the dashboard
- **Security** — Helmet, CSP, rate limiting on sensitive endpoints, CORS restricted to your domain, JWT secrets validated in production

---

## Quick start (local dev)

Requirements: **Node.js 20+** and **PostgreSQL**.

```bash
npm install
cp .env.example .env      # then fill in the values
npm run db:init           # create schema + seed data
npm run dev               # starts app (and embedded Postgres if none configured)
```

Open `http://localhost:8000`.

> Tip: an embedded Postgres instance is included for local testing
> (`npm run db:start`). In production use a managed PostgreSQL database.

## Quick start (production)

1. Create a PostgreSQL database (Render, Railway, Fly.io, Supabase, or any VPS).
2. Point `DATABASE_URL` (or the `PG*` vars) at it.
3. Set `JWT_SECRET` to a long random string.
4. Set `PUBLIC_URL` to your real domain.
5. Configure Stripe (see below) so buyers can activate the dashboard.
6. Start with `npm start`.

Full details: see `DEPLOYMENT.md` and `PAYMENTS.md`.

## Environment variables

See `.env.example` for the complete commented list. The critical ones:

| Variable              | Purpose                                   |
|-----------------------|-------------------------------------------|
| `PORT`                | HTTP port (default 8000)                  |
| `PUBLIC_URL`          | Your public domain (CORS + links)         |
| `JWT_SECRET`          | Session signing secret (required in prod) |
| `ADMIN_EMAIL`/`ADMIN_PASSWORD` | Admin bootstrap account           |
| `REQUIRE_LICENSE`     | Lock the dashboard behind a license key   |
| `LIFETIME_PRICE_CENTS`| License price in cents (e.g. 49900)       |
| `STRIPE_SECRET_KEY`   | Stripe secret key                         |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret           |
| `DATABASE_URL`/`PG*`  | PostgreSQL connection                     |

## Stripe licensing

The app ships with a complete "buy a lifetime license" flow:

- `POST /api/purchase/lifetime` — create a Stripe Checkout session
- `POST /api/payments/webhook` — Stripe webhook that issues the license (idempotent)
- `GET /api/purchase/license?session_id=...` — returns the permanent key after payment

Configure a webhook on `https://your-domain.com/api/payments/webhook` and subscribe to
`checkout.session.completed`. See `PAYMENTS.md`.

## Project structure

```
server.js                Express app — auth, quotes, bookings, dispatch, CRM, licensing
app.js                   Frontend logic (fetch + render, modals, navigation)
index.html               Single-page dashboard shell
styles.css               Styling
db.js                    PostgreSQL connection + schema + seed
scripts/
  init-database.js       Create schema + seed
  start-database.js      Embedded Postgres helper (dev)
  migrate-sqlite-to-postgres.js   Migrate old SQLite data
tests/
  license.test.js        11 automated tests (run with npm test)
.env.example             Template for all configuration
DEPLOYMENT.md            Deployment walkthrough
PAYMENTS.md              Stripe license setup
```

## Tests

```bash
npm test
```

11 tests covering license activation, the SaaS/billing layer, dispatch optimizer,
quote pricing, coverage zones, dashboard configuration, bookings, and the customer portal.

## License

One paid license per server/domain. Purchasing the code from the seller grants a
non-exclusive, non-transferable license to run this software for one organization.
Do not resell or redistribute the source intentionally.
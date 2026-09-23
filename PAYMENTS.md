# One-time lifetime purchase setup

This backend sells one permanent RZ Dispatch license. It uses Stripe Checkout in `payment` mode, not subscription mode.

## Configure

1. Create a Stripe account and enable your payment method.
2. Copy `.env.example` to `.env` and set:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `PUBLIC_URL`
   - `LIFETIME_PRICE_CENTS`
3. Configure a Stripe webhook for `POST /api/payments/webhook` with the `checkout.session.completed` event.
4. Start the server with the environment variables loaded.

## API

Create checkout:

```http
POST /api/purchase/lifetime
Content-Type: application/json

{"email":"buyer@example.com"}
```

The response contains `checkoutUrl`. Redirect the buyer to that URL.

After Stripe redirects to the success URL, request:

```http
GET /api/purchase/license?session_id=cs_...
```

The endpoint returns the permanent `licenseKey` only after Stripe reports the session as paid. The webhook also fulfills the license and is idempotent, so retries do not create duplicate licenses.

Do not put Stripe secret keys in frontend code or commit `.env`. In production, serve the app over HTTPS and store license records in a managed database with access controls and backups.

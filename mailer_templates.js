function brand(inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #f4f6f9; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1f2937; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
    .card { background: #ffffff; border-radius: 12px; padding: 28px; border: 1px solid #e5e7eb; }
    .logo { font-size: 20px; font-weight: 800; color: #1e3a8a; margin-bottom: 8px; }
    .muted { color: #6b7280; font-size: 13px; line-height: 1.5; }
    .lead { color: #111827; font-size: 15px; line-height: 1.6; }
    a.btn { display: inline-block; background: #1e3a8a; color: #ffffff !important; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 700; margin: 16px 0; }
    .small { font-size: 12px; color: #9ca3af; margin-top: 20px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="logo">RZ Dispatch</div>
      ${inner}
    </div>
  </div>
</body>
</html>`;
}

function welcomeEmail(name) {
  return brand(`
    <p class="lead">Hi ${name},</p>
    <p class="lead">Welcome to <strong>RZ Dispatch</strong>! Your customer account is created and awaiting approval.</p>
    <p class="muted">Once a dispatcher approves your account, you can sign in to book trips, track orders, and message the dispatch team anytime.</p>
    <div class="muted">
      <div><strong>Tip:</strong> Track any active order with the tracking link you receive after booking.</div>
    </div>
  `);
}

function verifyEmailEmail(name, link) {
  return brand(`
    <p class="lead">Hi ${name},</p>
    <p class="lead">Please confirm your email address to finish setting up your account.</p>
    <p><a class="btn" href="${link}">Confirm my email</a></p>
    <p class="muted">If you did not create an RZ Dispatch account, you can ignore this email.</p>
  `);
}

function passwordResetEmail(name, link, minutes) {
  return brand(`
    <p class="lead">Hi ${name},</p>
    <p class="lead">We received a request to reset your password.</p>
    <p><a class="btn" href="${link}">Reset my password</a></p>
    <p class="muted">This link expires in ${minutes} minutes. If you did not request this, you can safely ignore the email &mdash; your password will not change.</p>
  `);
}

module.exports = { welcomeEmail, verifyEmailEmail, passwordResetEmail };
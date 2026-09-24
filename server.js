require('dotenv').config();
const express = require('express');
const fs = require('fs');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const Stripe = require('stripe');
const { sendMail } = require('./mailer');
const { welcomeEmail, verifyEmailEmail, passwordResetEmail } = require('./mailer_templates');
const realtime = require('./realtime-hub');

const app = express();
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const GLOBAL_RATE_LIMIT = Number(process.env.GLOBAL_RATE_LIMIT) || 300;
app.set('trust proxy', TRUST_PROXY ? 1 : false);

// Safety nets so an unexpected error (a temporary database drop, a rejected
// async route, etc.) never takes the whole backend down with it. The error is
// logged, the server keeps serving, and the next request reconnects cleanly.
process.on('uncaughtException', (error) => {
  console.error('[backend] Uncaught exception (server keeps running):', error?.message || error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[backend] Unhandled rejection (server keeps running):', reason instanceof Error ? reason.message : reason);
});
const DATA_DIR = path.join(__dirname, '.data');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-insecure-secret-change-me');
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set. Using an insecure development secret. Set JWT_SECRET before deploying.');
}
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@rzdispatch.local').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Demo@12345';
const OPERATOR_EMAIL = (process.env.OPERATOR_EMAIL || 'operator@rzdispatch.local').toLowerCase();
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || 'Operator@12345';
const OPERATOR_DRIVER_ID = process.env.OPERATOR_DRIVER_ID || 'DR-102';
const APP_MODE = process.env.APP_MODE || 'saas';
const REQUIRE_LICENSE = process.env.REQUIRE_LICENSE !== 'false';
const DEMO_LICENSE_KEY = (process.env.DEMO_LICENSE_KEY || process.env.RZ_LICENSE_KEY || '').trim();
const LIFETIME_PRICE_CENTS = Number(process.env.LIFETIME_PRICE_CENTS) || 49900;
const LIFETIME_CURRENCY = process.env.LIFETIME_CURRENCY || 'usd';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
if (stripe && !stripeWebhookSecret) {
  console.warn('WARNING: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. License fulfillment via webhook will be unavailable.');
}

const rateBuckets = new Map();
// The PostgreSQL connection pool lives in ./db; schema/seed initialization is
// registered lazily below so it runs on the first database access.
const defaultJobs = [
  { id: 'JO-8421', type: 'PICKUP', priority: 'High priority', from: '1280 Market Street', to: '77 Geary Street', time: 'Today, 10:40 AM', distance: '2.4 mi', price: '$42.80', status: 'queued', lat: 37.7749, lng: -122.4194, toLat: 37.7889, toLng: -122.4069 },
  { id: 'JO-8418', type: 'DELIVERY', priority: 'Standard', from: '420 Hayes Street', to: '16th & Valencia', time: 'Today, 10:48 AM', distance: '3.1 mi', price: '$38.20', status: 'queued', lat: 37.7764, lng: -122.4232, toLat: 37.7646, toLng: -122.4214 },
  { id: 'JO-8415', type: 'PICKUP', priority: 'High priority', from: '85 2nd Street', to: 'Mission Bay', time: 'Today, 10:54 AM', distance: '4.8 mi', price: '$51.60', status: 'queued', lat: 37.7895, lng: -122.3998, toLat: 37.7702, toLng: -122.3889 },
  { id: 'JO-8409', type: 'DELIVERY', priority: 'Standard', from: '601 4th Street', to: 'Pier 39', time: 'Today, 11:02 AM', distance: '5.2 mi', price: '$44.10', status: 'queued', lat: 37.7822, lng: -122.3956, toLat: 37.8087, toLng: -122.4098 }
];
const defaultDrivers = [
  { id: 'DR-101', name: 'Marco Lee', initials: 'ML', status: 'On route', vehicle: 'Van 12', jobs: 8, rating: '4.9' },
  { id: 'DR-102', name: 'Sarah Kim', initials: 'SK', status: 'Available', vehicle: 'Van 08', jobs: 6, rating: '4.8' },
  { id: 'DR-103', name: 'Daniel Ruiz', initials: 'DR', status: 'On route', vehicle: 'Truck 21', jobs: 11, rating: '4.9' },
  { id: 'DR-104', name: 'Avery Chen', initials: 'AC', status: 'Offline', vehicle: 'Van 04', jobs: 5, rating: '4.7' }
];
const defaultActivity = [
  { initials: 'ML', name: 'Marco Lee', action: 'accepted job JO-8416', detail: 'Pickup at 2100 Franklin St', time: '2 min ago' },
  { initials: 'SK', name: 'Sarah Kim', action: 'arrived at pickup', detail: 'Job JO-8414 · 900 Battery St', time: '7 min ago' },
  { initials: 'DR', name: 'Daniel Ruiz', action: 'completed delivery', detail: 'Job JO-8408 · 1.2 mi trip', time: '12 min ago' }
];
const defaultMessages = [
  { sender: 'Sarah Kim', initials: 'SK', subject: 'Pickup delayed at 420 Hayes', body: 'Traffic is building near the pickup. I can still make the revised ETA if the next load is pushed by ten minutes.', type: 'operations' },
  { sender: 'Marco Lee', initials: 'ML', subject: 'Vehicle inspection complete', body: 'Van 12 passed inspection and is ready for another route.', type: 'fleet' },
  { sender: 'System', initials: 'RZ', subject: 'Route optimization applied', body: 'Your active loads were sequenced using priority and known distance.', type: 'system' }
];
const defaultServices = [
  { key: 'airport-transfer', name: 'Airport transfer', description: 'Flight-aware pickups and drop-offs for SFO, OAK, and SJC.', basePrice: 68, distanceRate: 2.75, hourlyRate: 0, active: 1 },
  { key: 'same-day', name: 'Same-day ride', description: 'Fast local transportation for urgent trips and business needs.', basePrice: 45, distanceRate: 2.25, hourlyRate: 0, active: 1 },
  { key: 'hourly', name: 'Hourly charter', description: 'Flexible multi-stop transport with a dedicated chauffeur.', basePrice: 55, distanceRate: 0, hourlyRate: 55, active: 1 },
  { key: 'charter', name: 'Full charter', description: 'Private group transportation for teams and events.', basePrice: 110, distanceRate: 3.5, hourlyRate: 110, active: 1 }
];
const defaultZones = [
  { key: 'downtown-sf', name: 'Downtown San Francisco', boundary: '37.7749,-122.4194;37.7955,-122.3937', baseSurcharge: 0, distanceSurcharge: 0, active: 1 },
  { key: 'south-bay', name: 'San Mateo & South Bay', boundary: '37.4419,-122.1430;37.6879,-122.4702', baseSurcharge: 8, distanceSurcharge: 0.35, active: 1 },
  { key: 'east-bay', name: 'East Bay', boundary: '37.8044,-122.2712;37.6879,-122.4702', baseSurcharge: 12, distanceSurcharge: 0.5, active: 1 },
  { key: 'north-bay', name: 'North Bay', boundary: '38.1041,-122.5697;37.8272,-122.4796', baseSurcharge: 15, distanceSurcharge: 0.65, active: 1 },
  { key: 'airport-corridors', name: 'Airport corridors', boundary: '37.6213,-122.3790;37.7126,-122.2120', baseSurcharge: 10, distanceSurcharge: 0.25, active: 1 }
];
const defaultVehicles = [
  { id: 'VH-001', plate: 'VAN-1280', make: 'Ford', model: 'Transit', year: 2024, vehicleType: 'van', capacity: 12, status: 'available', driverId: null, mileage: 42180 },
  { id: 'VH-002', plate: 'VAN-0842', make: 'Ford', model: 'Transit', year: 2023, vehicleType: 'van', capacity: 12, status: 'on-route', driverId: null, mileage: 38720 },
  { id: 'VH-003', plate: 'TRK-2100', make: 'Ford', model: 'F-550', year: 2024, vehicleType: 'truck', capacity: 4, status: 'on-route', driverId: null, mileage: 29450 },
  { id: 'VH-004', plate: 'VAN-0477', make: 'Mercedes', model: 'Sprinter', year: 2023, vehicleType: 'van', capacity: 14, status: 'available', driverId: null, mileage: 51230 },
  { id: 'VH-005', plate: 'SED-9201', make: 'Toyota', model: 'Camry', year: 2025, vehicleType: 'sedan', capacity: 4, status: 'available', driverId: null, mileage: 8120 },
  { id: 'VH-006', plate: 'SUV-5530', make: 'Toyota', model: 'Highlander', year: 2024, vehicleType: 'suv', capacity: 7, status: 'maintenance', driverId: null, mileage: 62340 },
  { id: 'VH-007', plate: 'VAN-3391', make: 'Ram', model: 'ProMaster', year: 2023, vehicleType: 'van', capacity: 10, status: 'off-duty', driverId: null, mileage: 44890 },
  { id: 'VH-008', plate: 'LUX-7700', make: 'Mercedes', model: 'S-Class', year: 2025, vehicleType: 'luxury', capacity: 3, status: 'available', driverId: null, mileage: 12680 }
];

// Create the schema and seed data on the first database access.
db.setInitializer(() => initializeDatabase());

const liveServerOrigins = ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5501', 'http://127.0.0.1:5501', 'http://localhost:3000', 'http://127.0.0.1:3000'];
const configuredOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
const allowedOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, PUBLIC_URL, ...configuredOrigins, ...liveServerOrigins];
app.disable('x-powered-by');
if (process.env.HTTPS_ONLY === 'true') {
  app.use((req, res, next) => {
    if (req.protocol === 'https' || req.get('x-forwarded-proto') === 'https') return next();
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  });
}
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://unpkg.com', 'https://*.unpkg.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'", 'https://unpkg.com', 'https://*.unpkg.com', "'unsafe-eval'"],
      imgSrc: ["'self'", 'data:', 'https://*.basemaps.cartocdn.com', 'https://basemaps.cartocdn.com', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
      connectSrc: ["'self'", 'https://unpkg.com', 'https://*.unpkg.com', ...allowedOrigins, ...allowedOrigins.map((o) => o.replace(/^http/, 'ws'))],
      workerSrc: ["'self'", 'blob:']
    }
  }
}));
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json({ limit: '5mb' }));
app.use('/api/auth', rateLimit({ windowMs: 60 * 1000, max: 20, name: 'auth' }));
app.use('/api/quotes', rateLimit({ windowMs: 60 * 1000, max: 20, name: 'quotes' }));
app.use('/api/bookings', rateLimit({ windowMs: 60 * 1000, max: 20, name: 'bookings' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-License-Key, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', rateLimit({ windowMs: 60 * 1000, max: GLOBAL_RATE_LIMIT, name: 'global' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'RZ Dispatch', appMode: APP_MODE, requireLicense: REQUIRE_LICENSE, version: '2.0.0' });
});

app.get('/api/support/tickets', requireAuth, requireStaff, async (req, res) => {
  const rows = await db.all('SELECT id, email, subject, message, status, created_at as createdAt FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC', req.user.id);
  res.json({ tickets: rows });
});

app.post('/api/support/ticket', requireAuth, requireStaff, async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });
  const ticket = {
    id: `TK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    userId: req.user.id,
    email: req.user.email,
    subject,
    message,
    status: 'open',
    createdAt: new Date().toISOString()
  };
  await db.run('INSERT INTO support_tickets (id, user_id, email, subject, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ticket.id, ticket.userId, ticket.email, ticket.subject, ticket.message, ticket.status, ticket.createdAt);
  res.status(201).json({ success: true, ticket });
});

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  // Registrants pick the kind of account they are signing up for:
  // - customer accounts get instant access to the customer portal,
  // - dispatcher and driver accounts require admin approval before they
  //   can sign in, since a dispatcher must confirm who will staff them.
  const requestedRole = String(req.body?.role || 'customer').trim().toLowerCase();
  const mapping = { customer: 'customer', dispatcher: 'owner', driver: 'operator' };
  const role = Object.prototype.hasOwnProperty.call(mapping, requestedRole) ? mapping[requestedRole] : 'customer';
  const needsApproval = role !== 'customer';

  const userId = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 12);
  await db.run('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    userId, email, passwordHash, role, needsApproval ? 'pending' : 'approved', new Date().toISOString());

  if (!needsApproval) {
    // Customer accounts are approved instantly so they can start booking,
    // tracking orders, and messaging dispatch without waiting on a dispatcher.
    const token = signToken({ id: userId, email, role, driverId: null });
    const settings = await getUserSettings({ id: userId, email });
    res.json({ token, user: { id: userId, email, role, driverId: null, name: settings.name } });
  } else {
    res.status(201).json({ success: true, pending: true, message: 'Your account has been created and is awaiting dispatcher approval. You will be able to sign in once a dispatcher approves it.' });
  }

  const verificationToken = createEmailVerificationToken({ id: userId, email });
  try {
    await sendMail(email, 'Welcome to RZ Dispatch', welcomeEmail(emailName(email)));
    await sendMail(email, 'Confirm your email address', verifyEmailEmail(emailName(email), verificationLink(verificationToken)));
  } catch (mailError) {
    console.error('[MAIL] failed to send registration email:', mailError.message);
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (user) {
    const token = createPasswordResetToken({ id: user.id, email: user.email });
    try {
      await sendMail(email, 'Reset your RZ Dispatch password', passwordResetEmail(emailName(email), resetLink(token), 60));
    } catch (mailError) {
      return res.status(500).json({ error: 'Could not send password reset email. Check SMTP configuration.' });
    }
  }
  res.json({ success: true, message: 'If that email exists, a password reset link has been sent.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  let payload;
  try {
    payload = verifyPasswordResetToken(token);
  } catch (error) {
    return res.status(400).json({ error: 'Reset token is invalid or has expired.' });
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 12), payload.userId);
  res.json({ success: true, message: 'Password updated. You can now sign in.' });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // Admin approval workflow: only approved accounts may sign in.
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is currently awaiting admin approval.' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Your registration request was declined.' });
  }

  const token = signToken({ id: user.id, email: user.email, role: user.role, driverId: user.driver_id });
  const settings = await getUserSettings(user);
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, driverId: user.driver_id, name: settings.name } });
});

app.get('/api/operator/jobs', requireAuth, requireOperator, async (req, res) => {
  const driver = (await getDrivers()).find((item) => item.id === req.user.driverId);
  const jobs = (await getJobs()).filter((job) => job.driver === driver?.name);
  res.json({ operator: { id: req.user.id, email: req.user.email, driverId: req.user.driverId, name: driver?.name || req.user.email }, jobs, updatedAt: new Date().toISOString() });
});

app.get('/api/operator/jobs/:id', requireAuth, requireOperator, async (req, res) => {
  const job = await getOperatorJob(req.user, req.params.id);
  if (!job) return res.status(404).json({ error: 'Assigned job not found.' });
  const proof = await db.all('SELECT id, file_name as fileName, mime_type as mimeType, byte_size as byteSize, created_at as createdAt FROM proof_documents WHERE job_id = ? AND operator_id = ? ORDER BY created_at DESC', job.id, req.user.id);
  res.json({ job, proof });
});

app.patch('/api/operator/jobs/:id/status', requireAuth, requireOperator, async (req, res) => {
  const job = await getOperatorJob(req.user, req.params.id);
  if (!job) return res.status(404).json({ error: 'Assigned job not found.' });
  const nextStatus = String(req.body?.status || '').toLowerCase();
  const allowed = { assigned: ['en_route'], en_route: ['arrived'], arrived: ['picked_up'], picked_up: ['delivered'], delivered: [] };
  if (!allowed[job.status]?.includes(nextStatus)) return res.status(400).json({ error: `Cannot move ${job.id} from ${job.status} to ${nextStatus}.` });
  const storedStatus = nextStatus === 'delivered' ? 'completed' : nextStatus;
  await db.run('UPDATE jobs SET status = ? WHERE id = ?', storedStatus, job.id);
  await activityPush({ initials: 'OP', name: await driverDisplayName(req.user), action: `moved ${job.id} to ${nextStatus}`, detail: `${job.from} to ${job.to}`, time: 'just now' });
  const updatedJob = await getOperatorJob(req.user, job.id);
  await announceJobChange({ ...updatedJob, operatorDriverId: req.user.driverId });
  res.json({ job: updatedJob, message: `${job.id} is now ${nextStatus}` });
});

app.post('/api/operator/jobs/:id/proof', requireAuth, requireOperator, async (req, res) => {
  const job = await getOperatorJob(req.user, req.params.id);
  if (!job) return res.status(404).json({ error: 'Assigned job not found.' });
  const mimeType = String(req.body?.mimeType || '').toLowerCase();
  const fileName = String(req.body?.fileName || 'proof-of-delivery').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const encoded = String(req.body?.data || '');
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mimeType)) return res.status(415).json({ error: 'Only JPG, PNG, or PDF proof documents are accepted.' });
  if (!encoded || encoded.length > 4_200_000) return res.status(413).json({ error: 'Proof document is missing or larger than 3 MB.' });
  let buffer;
  try { buffer = Buffer.from(encoded.replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch (error) { return res.status(400).json({ error: 'Invalid proof document encoding.' }); }
  if (!buffer.length || buffer.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'Proof document is missing or larger than 3 MB.' });
  const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
  const documentId = crypto.randomUUID();
  const relativePath = path.join('proof', `${documentId}.${extension}`);
  const absolutePath = path.join(DATA_DIR, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer, { flag: 'wx' });
  await db.run('INSERT INTO proof_documents (id, job_id, operator_id, file_name, mime_type, file_path, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', documentId, job.id, req.user.id, fileName, mimeType, relativePath, buffer.length, new Date().toISOString());
  await activityPush({ initials: 'OP', name: await driverDisplayName(req.user), action: `uploaded proof for ${job.id}`, detail: fileName, time: 'just now' });
  res.status(201).json({ proof: { id: documentId, jobId: job.id, fileName, mimeType, byteSize: buffer.length }, message: 'Proof of delivery uploaded.' });
});

app.get('/api/operator/messages', requireAuth, requireOperator, async (req, res) => {
  const driverId = req.user.driverId;
  const rows = await db.all(`SELECT id, sender, initials, subject, body, type, operator_driver_id as operatorDriverId, operator_name as operatorName, recipient_driver_id as recipientDriverId, is_read as isRead, created_at as createdAt
    FROM messages WHERE operator_driver_id = ? OR recipient_driver_id = ? ORDER BY created_at ASC LIMIT 200`, driverId, driverId);
  res.json({ driverId, driverName: await driverDisplayName(req.user), messages: rows, unread: rows.filter((m) => m.isRead === 0 && m.recipientDriverId === driverId).length });
});

app.post('/api/operator/messages', requireAuth, requireOperator, async (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0, 160);
  const body = String(req.body?.body || '').trim();
  if (!subject || !body || body.length > 1000) return res.status(400).json({ error: 'A subject and message are required.' });
  const driverName = await driverDisplayName(req.user);
  const message = {
    id: crypto.randomUUID(),
    sender: driverName,
    initials: makeInitials(driverName),
    subject,
    body,
    type: 'operator',
    isRead: 0,
    createdAt: new Date().toISOString(),
    operatorDriverId: req.user.driverId,
    operatorName: driverName,
    recipientDriverId: null
  };
  await db.run('INSERT INTO messages (id, sender, initials, subject, body, type, customer_email, customer_name, operator_driver_id, operator_name, recipient_driver_id, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', message.id, message.sender, message.initials, message.subject, message.body, message.type, null, null, message.operatorDriverId, message.operatorName, message.recipientDriverId, message.isRead, message.createdAt);
  await announceMessage(message);
  res.status(201).json({ message });
});

app.get('/api/operator/proof/:id', requireAuth, requireOperator, async (req, res) => {
  const document = await db.get('SELECT * FROM proof_documents WHERE id = ? AND operator_id = ?', req.params.id, req.user.id);
  if (!document) return res.status(404).json({ error: 'Proof document not found.' });
  const absolutePath = path.join(DATA_DIR, document.file_path);
  if (!fs.existsSync(absolutePath)) return res.status(410).json({ error: 'Proof document is no longer available.' });
  res.type(document.mime_type).sendFile(path.resolve(absolutePath), { dotfiles: 'allow' });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const settings = await getUserSettings(req.user);
  res.json({ user: { ...req.user, name: settings.name } });
});

async function getUserSettings(user) {
  const row = await db.get('SELECT name, phone, notify_email as notifyEmail, notify_sms as notifySms, notify_inapp as notifyInapp, country, locale, currency, timezone, vehicle_type as vehicleType, passengers, notify_email as notifyEmail2 FROM user_settings WHERE user_id = ?', user.id);
  return {
    name: row?.name || emailName(user.email),
    phone: row?.phone || '',
    notifyEmail: row?.notifyEmail === undefined ? 1 : Number(row.notifyEmail),
    notifySms: row?.notifySms === undefined ? 0 : Number(row.notifySms),
    notifyInapp: row?.notifyInapp === undefined ? 1 : Number(row.notifyInapp),
    country: row?.country || '',
    locale: row?.locale || '',
    currency: row?.currency || '',
    timezone: row?.timezone || '',
    vehicleType: row?.vehicleType || '',
    passengers: String(row?.passengers ?? '') || ''
  };
}

app.get('/api/settings', requireAuth, async (req, res) => {
  const settings = await getUserSettings(req.user);
  res.json({ settings: { ...settings, email: req.user.email, role: req.user.role } });
});

app.patch('/api/settings', requireAuth, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Display name is required.' });
  const phone = String(body.phone || '').trim().slice(0, 30);
  const notifyEmail = body.notifyEmail === undefined ? 1 : (body.notifyEmail ? 1 : 0);
  const notifySms = body.notifySms === undefined ? 0 : (body.notifySms ? 1 : 0);
  const notifyInapp = body.notifyInapp === undefined ? 1 : (body.notifyInapp ? 1 : 0);
  await db.run('INSERT INTO user_settings (user_id, name, phone, notify_email, notify_sms, notify_inapp, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, notify_email = EXCLUDED.notify_email, notify_sms = EXCLUDED.notify_sms, notify_inapp = EXCLUDED.notify_inapp, updated_at = EXCLUDED.updated_at',
    req.user.id, name, phone, notifyEmail, notifySms, notifyInapp, new Date().toISOString());
  res.json({ success: true, settings: { name, phone, email: req.user.email, role: req.user.role, notifyEmail, notifySms, notifyInapp } });
});

app.post('/api/settings/password', requireAuth, async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  const currentUser = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!currentUser || !bcrypt.compareSync(current, currentUser.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  if (bcrypt.compareSync(next, currentUser.password_hash)) return res.status(400).json({ error: 'New password must be different from the current password.' });
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(next, 12), req.user.id);
  res.json({ success: true });
});

app.get('/api/account/summary', requireAuth, async (req, res) => {
  res.json(await buildAccountSummary(req.user));
});

app.get('/api/admin/overview', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  res.json(await getAdminOverview());
});

app.get('/api/admin/billing', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  res.json(await buildBillingSummary());
});

function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

app.get('/api/admin/users', requireAuth, isAdmin, async (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const allowed = ['pending', 'approved', 'rejected'];
  const users = allowed.includes(status)
    ? await db.all("SELECT id, email, role, status, driver_id as driverId, created_at as createdAt FROM users WHERE status = ? ORDER BY created_at DESC", status)
    : await db.all("SELECT id, email, role, status, driver_id as driverId, created_at as createdAt FROM users ORDER BY created_at DESC");
  res.json({ users });
});

app.patch('/api/admin/users/:id/approve', requireAuth, isAdmin, async (req, res) => {
  const user = await db.get('SELECT id FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  // Dispatchers pick an access role when approving a registration:
  // customer (default) -> customer portal, operator -> driver portal
  // (requires a linked driver), dispatcher/owner -> dispatch portal.
  let role = String(req.body?.role || 'customer').trim().toLowerCase();
  const allowedRoles = ['customer', 'operator', 'owner'];
  if (!allowedRoles.includes(role)) role = 'customer';
  const driverId = role === 'operator' ? String(req.body?.driverId || '').trim() : null;
  if (role === 'operator' && !driverId) return res.status(400).json({ error: 'Select a driver to link this operator account to.' });
  await db.run("UPDATE users SET status = 'approved', role = ?, driver_id = ? WHERE id = ?", role, driverId, req.params.id);
  res.json({ success: true, message: 'Account approved.', user: { id: user.id, status: 'approved', role, driverId } });
});

app.patch('/api/admin/users/:id/reject', requireAuth, isAdmin, async (req, res) => {
  const user = await db.get('SELECT id FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  await db.run("UPDATE users SET status = 'rejected' WHERE id = ?", req.params.id);
  res.json({ success: true, message: 'Registration declined.', user: { id: user.id, status: 'rejected' } });
});

app.post('/api/auth/verify-email', requireAuth, async (req, res) => {
  const user = req.user;
  const fullUser = await db.get('SELECT * FROM users WHERE id = ?', user.id);
  const email = fullUser?.email || user.email;
  const token = createEmailVerificationToken({ id: user.id, email });
  try {
    await sendMail(email, 'Confirm your email address', verifyEmailEmail(emailName(email), verificationLink(token)));
  } catch (mailError) {
    return res.status(500).json({ error: 'Could not send verification email. Check SMTP configuration.' });
  }
  res.json({ success: true, sent: true, email });
});

app.get('/api/auth/verify-email/:token', (req, res) => {
  try {
    const payload = verifyEmailToken(req.params.token);
    res.json({ success: true, verified: true, userId: payload.userId, email: payload.email });
  } catch (error) {
    res.status(400).json({ error: 'Verification token is invalid or expired.' });
  }
});

app.get('/api/license/status', async (req, res) => {
  let user = null;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    try { user = jwt.verify(bearer, JWT_SECRET); } catch (_) { /* optional auth only */ }
  }
  const suppliedKey = getLicenseKeyFromRequest(req);
  const active = await hasValidLicense(user, suppliedKey);
  res.json({
    active,
    locked: REQUIRE_LICENSE,
    mode: APP_MODE,
    message: active ? 'License active' : 'License required',
    demoKeyConfigured: Boolean(DEMO_LICENSE_KEY),
    paymentsConfigured: Boolean(stripe)
  });
});

app.post('/api/license/activate', requireAuth, async (req, res) => {
  const submittedKey = String(req.body?.licenseKey || '').trim();
  const email = String(req.body?.email || '').trim();

  if (!submittedKey && !email) {
    return res.status(400).json({ error: 'Provide a license key or email to activate.' });
  }

  if (submittedKey && !validateLicenseKey(submittedKey) && !(DEMO_LICENSE_KEY && normalizeLicenseKey(DEMO_LICENSE_KEY) === normalizeLicenseKey(submittedKey))) {
    return res.status(400).json({ error: 'This license key is invalid.' });
  }

  const normalizedKey = normalizeLicenseKey(submittedKey || DEMO_LICENSE_KEY);
  if (!normalizedKey) {
    return res.status(402).json({ error: 'No active license found. Start checkout to unlock the app.' });
  }

  const existing = await findLicenseRecord(normalizedKey, req.user.id);
  if (existing) {
    return res.json({ success: true, licenseKey: existing.licenseKey, type: existing.type, status: existing.status });
  }

  if (DEMO_LICENSE_KEY && normalizeLicenseKey(DEMO_LICENSE_KEY) === normalizedKey) {
    const record = await createLicenseRecord({ userId: req.user.id, customerEmail: email || req.user.email, source: 'demo', stripeSessionId: null, licenseKey: null });
    return res.json({ success: true, licenseKey: record.licenseKey, type: record.type, status: record.status });
  }

  return res.status(404).json({ error: 'License not found or not active.' });
});

app.use('/api', (req, res, next) => {
  const normalizedPath = req.path.replace(/\/+$/, '');
  if (normalizedPath === '/customer/order') return next();
  if (normalizedPath === '/customer/stats') return next();
  if (normalizedPath === '/quotes/estimate' && req.method === 'POST') return next();
  if (normalizedPath === '/quotes/distance' && req.method === 'POST') return next();
  if (normalizedPath === '/bookings' && req.method === 'POST') return next();
  if (normalizedPath === '/customer/messages' && req.method === 'GET') return next();
  if (normalizedPath === '/customer/contact' && req.method === 'POST') return next();
  return requireAuth(req, res, next);
});

app.use('/api', async (req, res, next) => {
  if (!REQUIRE_LICENSE) return next();
  const publicLicensePaths = ['/customer/order', '/customer/stats', '/customer/messages', '/customer/contact', '/purchase/lifetime', '/purchase/license', '/quotes/estimate', '/quotes/distance', '/bookings'];
  const normalizedPath = req.path.replace(/\/+$/, '');
  if (publicLicensePaths.some((p) => normalizedPath === p)) return next();
  const key = getLicenseKeyFromRequest(req);
  if (await hasValidLicense(req.user, key)) return next();
  return res.status(402).json({ error: 'License required', licenseRequired: true, message: 'Activate your RZ Dispatch license to continue.' });
});

app.get('/api/customer/order', async (req, res) => {
  const orderId = String(req.query.orderId || '').trim();
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!orderId || !email) {
    return res.status(400).json({ error: 'Both orderId and email are required.' });
  }

  const result = await lookupCustomerOrder({ orderId, email });
  if (!result) {
    return res.status(404).json({ error: 'No order found for that email and order ID.' });
  }

  res.json(result);
});

app.get('/api/customer/stats', async (req, res) => {
  try {
    const totalOrdersRow = await db.get('SELECT (SELECT COUNT(*) FROM quotes) + (SELECT COUNT(*) FROM bookings) AS total');
    const customersRow = await db.get(`SELECT COUNT(*) AS total FROM (SELECT LOWER(email) AS email FROM quotes UNION SELECT LOWER(email) AS email FROM bookings) AS combined`);
    const driversRow = await db.get('SELECT COUNT(*) AS total FROM drivers');
    res.json({ stats: { orders: Number(totalOrdersRow.total) || 0, customers: Number(customersRow.total) || 0, drivers: Number(driversRow.total) || 0 }, ok: true });
  } catch (error) {
    res.json({ stats: { orders: 0, customers: 0, drivers: 0 }, ok: true });
  }
});

app.post('/api/quotes/distance', async (req, res) => {
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  if (!from || !to) return res.status(400).json({ ok: false, error: 'Add a pickup and dropoff address first.' });
  try {
    const miles = await estimateRouteMiles(from, to);
    if (miles == null) return res.status(422).json({ ok: false, error: 'Could not look up a distance for those addresses — enter an estimate manually.' });
    res.json({ ok: true, miles, from, to });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Distance lookup is temporarily unavailable — enter miles manually.' });
  }
});

app.post('/api/customer/contact', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
  const subject = String(req.body?.subject || '').trim().slice(0, 200);
  const body = String(req.body?.body || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!isText(subject) || !isText(body)) return res.status(400).json({ error: 'Add a subject and a message.' });
  const message = {
    id: crypto.randomUUID(),
    sender: name || 'Valued customer',
    initials: makeInitials(name || 'Customer'),
    subject,
    body,
    type: 'customer',
    isRead: 0,
    createdAt: new Date().toISOString(),
    customerEmail: email,
    customerName: name || ''
  };
  await db.run('INSERT INTO messages (id, sender, initials, subject, body, type, customer_email, customer_name, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', message.id, message.sender, message.initials, message.subject, message.body, message.type, message.customerEmail, message.customerName, message.isRead, message.createdAt);
  await activityPush({ initials: message.initials, name: message.customerName || message.sender, action: 'messaged dispatch', detail: subject, time: 'just now' });
  await announceMessage({ ...message, operator_driver_id: null, operator_name: null, recipient_driver_id: null });
  res.status(201).json({ success: true, message: { id: message.id, sender: message.sender, subject: message.subject, body: message.body, createdAt: message.createdAt } });
});

app.get('/api/customer/messages', async (req, res) => {
  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const messages = await db.all('SELECT sender, initials, subject, body, type, created_at as createdAt FROM messages WHERE LOWER(customer_email) = ? ORDER BY created_at ASC LIMIT 200', email);
  res.json({ email, messages, count: messages.length, unreadReplies: messages.filter((m) => m.type !== 'customer').length });
});

app.get('/api/customer/me', requireAuth, requireCustomer, async (req, res) => {
  const settings = await getUserSettings(req.user);
  settings.email = req.user.email;
  settings.role = req.user.role;
  res.json({ profile: settings });
});

app.put('/api/customer/me', requireAuth, requireCustomer, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Full name is required.' });
  const phone = String(body.phone || '').trim().slice(0, 30);
  const country = String(body.country || '').trim().slice(0, 40);
  const locale = String(body.locale || '').trim().slice(0, 10);
  const currency = String(body.currency || '').trim().toUpperCase().slice(0, 3);
  const timezone = String(body.timezone || '').trim().slice(0, 40);
  const vehicleType = String(body.vehicleType || 'car').trim().slice(0, 20);
  const passengers = Math.max(1, Math.min(12, Number(body.passengers) || 1));
  const notifyEmail = body.notifyEmail === undefined ? 1 : (body.notifyEmail ? 1 : 0);
  const notifySms = body.notifySms === undefined ? 0 : (body.notifySms ? 1 : 0);
  const notifyInapp = body.notifyInapp === undefined ? 1 : (body.notifyInapp ? 1 : 0);
  await db.run('INSERT INTO user_settings (user_id, name, phone, notify_email, notify_sms, notify_inapp, country, locale, currency, timezone, vehicle_type, passengers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, notify_email = EXCLUDED.notify_email, notify_sms = EXCLUDED.notify_sms, notify_inapp = EXCLUDED.notify_inapp, country = EXCLUDED.country, locale = EXCLUDED.locale, currency = EXCLUDED.currency, timezone = EXCLUDED.timezone, vehicle_type = EXCLUDED.vehicle_type, passengers = EXCLUDED.passengers, updated_at = EXCLUDED.updated_at',
    req.user.id, name, phone, notifyEmail, notifySms, notifyInapp, country, locale, currency, timezone, vehicleType, passengers, new Date().toISOString());
  const settings = await getUserSettings(req.user);
  settings.email = req.user.email;
  settings.role = req.user.role;
  res.json({ ok: true, profile: settings });
});

function mapCustomerAddressRow(row) {
  return {
    id: row.id,
    label: row.label,
    lineOne: row.line_one,
    lineTwo: row.line_two,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    phone: row.phone,
    isDefault: Number(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getCustomerAddresses(userId) {
  return (await db.all('SELECT id, label, line_one, line_two, city, region, postal_code, country, phone, is_default, created_at, updated_at FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at ASC', userId)).map(mapCustomerAddressRow);
}

app.get('/api/customer/addresses', requireAuth, requireCustomer, async (req, res) => {
  res.json({ addresses: await getCustomerAddresses(req.user.id) });
});

app.post('/api/customer/addresses', requireAuth, requireCustomer, async (req, res) => {
  const body = req.body || {};
  const label = String(body.label || '').trim().slice(0, 40);
  if (!label) return res.status(400).json({ error: 'Give this place a label.' });
  const lineOne = String(body.lineOne || '').trim().slice(0, 120);
  if (!lineOne) return res.status(400).json({ error: 'Enter an address line.' });
  const existing = await db.get('SELECT COUNT(*) as count FROM customer_addresses WHERE user_id = ?', req.user.id);
  const isFirst = Number(existing?.count || 0) === 0;
  const isDefault = isFirst || (body.isDefault ? 1 : 0);
  const id = `AD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  if (isDefault) await db.run('UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?', req.user.id);
  await db.run(`INSERT INTO customer_addresses (id, user_id, label, line_one, line_two, city, region, postal_code, country, phone, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, req.user.id, label, lineOne, String(body.lineTwo || '').trim().slice(0, 120), String(body.city || '').trim().slice(0, 80), String(body.region || '').trim().slice(0, 80), String(body.postalCode || '').trim().slice(0, 20), String(body.country || '').trim().slice(0, 40), String(body.phone || '').trim().slice(0, 30), isDefault, now, now);
  res.json({ ok: true, address: mapCustomerAddressRow(await db.get('SELECT * FROM customer_addresses WHERE id = ?', id)) });
});

app.patch('/api/customer/addresses/:id', requireAuth, requireCustomer, async (req, res) => {
  const row = await db.get('SELECT * FROM customer_addresses WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Saved place not found.' });
  const body = req.body || {};
  if (body.isDefault) {
    await db.run('UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?', req.user.id);
    await db.run('UPDATE customer_addresses SET is_default = 1, updated_at = ? WHERE id = ?', new Date().toISOString(), row.id);
    return res.json({ ok: true, address: mapCustomerAddressRow(await db.get('SELECT * FROM customer_addresses WHERE id = ?', row.id)) });
  }
  const label = String(body.label ?? row.label).trim();
  if (!label) return res.status(400).json({ error: 'Give this place a label.' });
  const lineOne = String(body.lineOne ?? row.line_one).trim();
  if (!lineOne) return res.status(400).json({ error: 'Enter an address line.' });
  await db.run('UPDATE customer_addresses SET label = ?, line_one = ?, line_two = ?, city = ?, region = ?, postal_code = ?, country = ?, phone = ?, updated_at = ? WHERE id = ?',
    label, lineOne, String(body.lineTwo ?? row.line_two).trim().slice(0, 120), String(body.city ?? row.city).trim().slice(0, 80), String(body.region ?? row.region).trim().slice(0, 80), String(body.postalCode ?? row.postal_code).trim().slice(0, 20), String(body.country ?? row.country).trim().slice(0, 40), String(body.phone ?? row.phone).trim().slice(0, 30), new Date().toISOString(), row.id);
  res.json({ ok: true, address: mapCustomerAddressRow(await db.get('SELECT * FROM customer_addresses WHERE id = ?', row.id)) });
});

app.delete('/api/customer/addresses/:id', requireAuth, requireCustomer, async (req, res) => {
  const row = await db.get('SELECT * FROM customer_addresses WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Saved place not found.' });
  await db.run('DELETE FROM customer_addresses WHERE id = ?', row.id);
  if (Number(row.is_default) === 1) {
    const next = await db.get('SELECT id FROM customer_addresses WHERE user_id = ? ORDER BY created_at ASC LIMIT 1', req.user.id);
    if (next) await db.run('UPDATE customer_addresses SET is_default = 1, updated_at = ? WHERE id = ?', new Date().toISOString(), next.id);
  }
  res.json({ ok: true });
});

function toShopReceipt(record, kind) {
  const value = Number(record.quoteTotal ?? record.total ?? record.bookingTotal ?? 0) || 0;
  const id = String(record.id || '').trim();
  const label = kind === 'booking'
    ? `Booking to ${record.dropoffAddress || 'your destination'}`
    : `Quote for ${record.serviceType || 'a ride'}`;
  return {
    id,
    kind,
    label,
    serviceType: record.serviceType || '',
    issuedAt: record.createdAt || record.issuedAt || '',
    status: record.status || 'draft',
    serviceDate: record.serviceDate || '',
    pickupAddress: record.pickupAddress || '',
    dropoffAddress: record.dropoffAddress || '',
    vehicleType: record.vehicleType || '',
    miles: Number(record.miles) || 0,
    passengers: Number(record.passengers) || 0,
    hours: Number(record.hours) || 0,
    total: value,
    notes: record.notes || ''
  };
}

app.get('/api/customer/receipts', requireAuth, requireCustomer, async (req, res) => {
  const email = String(req.user.email || '').trim().toLowerCase();
  const [quotes, bookings] = await Promise.all([getQuoteRecords(), getBookingRecords()]);
  const receipts = [
    ...quotes.filter((q) => String(q.email || '').trim().toLowerCase() === email).map((q) => toShopReceipt(q, 'quote')),
    ...bookings.filter((b) => String(b.email || '').trim().toLowerCase() === email).map((b) => toShopReceipt(b, 'booking'))
  ].sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
  res.json({ receipts });
});

app.get('/api/customer/receipts/:id', requireAuth, requireCustomer, async (req, res) => {
  const email = String(req.user.email || '').trim().toLowerCase();
  const id = String(req.params.id || '').trim();
  const [quotes, bookings] = await Promise.all([getQuoteRecords(), getBookingRecords()]);
  const candidate = [
    ...quotes.filter((q) => String(q.email || '').trim().toLowerCase() === email).map((q) => toShopReceipt(q, 'quote')),
    ...bookings.filter((b) => String(b.email || '').trim().toLowerCase() === email).map((b) => toShopReceipt(b, 'booking'))
  ].find((r) => r.id === id);
  if (!candidate) return res.status(404).json({ error: 'Receipt not found.' });
  res.json({ receipt: candidate });
});

app.get('/api/dashboard', requireAuth, requireStaff, async (req, res) => {
  const jobs = await getJobs();
  const assigned = jobs.filter((job) => job.status === 'assigned').length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  res.json({ metrics: { active: queued + assigned + 20, onRoad: 18 + assigned, available: Math.max(0, 6 - assigned), eta: 18 }, jobs, updatedAt: new Date().toISOString() });
});

app.get('/api/overview', requireAuth, requireStaff, async (req, res) => {
  const jobs = await getJobs();
  const assigned = jobs.filter((job) => job.status === 'assigned').length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const drivers = await getDriverAvailability();
  const vehicles = await getVehicles();
  const activity = await getActivity();
  res.json({
    metrics: { active: queued + assigned + 20, onRoad: 18 + assigned, available: Math.max(0, 6 - assigned), eta: 18 },
    jobs,
    drivers,
    vehicles,
    activity,
    analytics: { completed: 38 + assigned, onTimeRate: 92, utilization: 78, distance: `${(142 + assigned * 2).toFixed(1)} mi` },
    bookings: await getBookingRecords(),
    quotes: await getQuoteRecords(),
    updatedAt: new Date().toISOString()
  });
});

app.get('/api/search', requireAuth, requireStaff, async (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  if (!query) return res.json({ results: [] });
  const jobs = (await getJobs()).filter((job) => [job.id, job.from, job.to, job.driver, job.status].some((value) => String(value || '').toLowerCase().includes(query))).map((job) => ({ type: 'job', id: job.id, label: `${job.id} · ${job.from} → ${job.to}`, status: job.status }));
  const customers = (await buildCustomerDirectory()).filter((customer) => [customer.name, customer.email, customer.phone].some((value) => String(value || '').toLowerCase().includes(query))).map((customer) => ({ type: 'customer', id: customer.id, label: `${customer.name} · ${customer.email}`, status: `${customer.bookings} bookings` }));
  const services = (await getServiceConfigurations()).filter((service) => [service.key, service.name, service.description].some((value) => String(value || '').toLowerCase().includes(query))).map((service) => ({ type: 'service', id: service.key, label: service.name, status: service.active ? 'Active' : 'Hidden' }));
  res.json({ results: [...jobs, ...customers, ...services].slice(0, 20) });
});

app.get('/api/notifications', requireAuth, requireStaff, async (req, res) => {
  const messages = await db.all('SELECT id, subject, body, type, created_at as createdAt FROM messages WHERE is_read = 0 ORDER BY created_at DESC LIMIT 20');
  res.json({ notifications: messages, unread: messages.length });
});

app.get('/api/realtime/presence', requireAuth, requireStaff, (req, res) => {
  res.json({ enabled: realtime.isRealtimeEnabled(), online: realtime.presenceSnapshot() });
});

app.get('/api/activity', requireAuth, requireStaff, async (req, res) => {
  res.json({ activity: await db.all('SELECT initials, name, action, detail, time, created_at as createdAt FROM activity ORDER BY created_at DESC LIMIT 100') });
});

app.get('/api/messages', requireAuth, requireStaff, async (req, res) => {
  const filter = String(req.query?.filter || 'all').toLowerCase();
  const search = String(req.query?.search || '').trim();
  const params = [];
  let where = '';
  if (filter === 'unread') { where = 'WHERE is_read = 0'; }
  if (search) { where += where ? ' AND ' : 'WHERE '; where += '(subject ILIKE ? OR body ILIKE ? OR sender ILIKE ? OR customer_email ILIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  const messages = await db.all(`SELECT id, sender, initials, subject, body, type, customer_email as customerEmail, customer_name as customerName, operator_driver_id as operatorDriverId, operator_name as operatorName, recipient_driver_id as recipientDriverId, is_read as isRead, created_at as createdAt FROM messages ${where} ORDER BY created_at DESC LIMIT 100`, ...params);
  const unread = Number((await db.get('SELECT COUNT(*) as count FROM messages WHERE is_read = 0'))?.count || 0);
  res.json({ messages, unread });
});

app.post('/api/messages', requireStaff, async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const body = String(req.body?.body || '').trim();
  const type = String(req.body?.type || 'operations').trim().toLowerCase();
  const customerEmail = String(req.body?.customerEmail || '').trim().toLowerCase().slice(0, 200) || null;
  const customerName = String(req.body?.customerName || '').trim().slice(0, 80) || null;
  const recipientDriverId = String(req.body?.driverId || req.body?.recipientDriverId || '').trim() || null;
  if (!isText(subject) || !isText(body)) return res.status(400).json({ error: 'Subject and message are required.' });
  const message = { id: crypto.randomUUID(), sender: req.user.email, initials: req.user.email.slice(0, 2).toUpperCase(), subject, body, type, isRead: 1, createdAt: new Date().toISOString(), customerEmail, customerName, recipientDriverId };
  await db.run('INSERT INTO messages (id, sender, initials, subject, body, type, customer_email, customer_name, operator_driver_id, operator_name, recipient_driver_id, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', message.id, message.sender, message.initials, message.subject, message.body, message.type, message.customerEmail, message.customerName, null, null, message.recipientDriverId, message.isRead, message.createdAt);
  await announceMessage(message);
  res.status(201).json({ message });
});

app.patch('/api/messages/:id/read', requireAuth, requireStaff, async (req, res) => {
  const isRead = req.body?.isRead === undefined ? 1 : (req.body.isRead ? 1 : 0);
  const result = await db.run('UPDATE messages SET is_read = ? WHERE id = ?', isRead, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Message not found' });
  const unread = Number((await db.get('SELECT COUNT(*) as count FROM messages WHERE is_read = 0'))?.count || 0);
  realtime.broadcast('message.read', { id: req.params.id, isRead, unread });
  res.json({ success: true, id: req.params.id, isRead, unread });
});

app.delete('/api/messages/:id', requireAuth, requireStaff, async (req, res) => {
  const msg = await db.get('SELECT id FROM messages WHERE id = ?', req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  await db.run('DELETE FROM messages WHERE id = ?', req.params.id);
  const unread = Number((await db.get('SELECT COUNT(*) as count FROM messages WHERE is_read = 0'))?.count || 0);
  realtime.broadcast('message.deleted', { id: req.params.id, unread });
  res.json({ success: true, id: req.params.id, unread });
});

app.get('/api/services', requireAuth, requireStaff, async (req, res) => {
  res.json({ services: await getServiceConfigurations() });
});

app.post('/api/services', requireStaff, async (req, res) => {
  const service = normalizeServiceInput(req.body || {});
  if (!service.key || !service.name || !service.description) return res.status(400).json({ error: 'Key, name, and description are required.' });
  if (await db.get('SELECT key FROM services WHERE key = ?', service.key)) return res.status(409).json({ error: 'A service with this key already exists.' });
  await db.run('INSERT INTO services (key, name, description, base_price, distance_rate, hourly_rate, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', service.key, service.name, service.description, service.basePrice, service.distanceRate, service.hourlyRate, service.active, new Date().toISOString());
  res.status(201).json({ service: (await getServiceConfigurations()).find((item) => item.key === service.key) });
});

app.patch('/api/services/:key', requireStaff, async (req, res) => {
  const current = await db.get('SELECT key FROM services WHERE key = ?', req.params.key);
  if (!current) return res.status(404).json({ error: 'Service not found.' });
  const service = normalizeServiceInput(req.body || {}, req.params.key);
  if (!service.name || !service.description) return res.status(400).json({ error: 'Name and description are required.' });
  await db.run('UPDATE services SET name = ?, description = ?, base_price = ?, distance_rate = ?, hourly_rate = ?, active = ?, updated_at = ? WHERE key = ?', service.name, service.description, service.basePrice, service.distanceRate, service.hourlyRate, service.active, new Date().toISOString(), req.params.key);
  res.json({ service: (await getServiceConfigurations()).find((item) => item.key === req.params.key) });
});

app.delete('/api/services/:key', requireStaff, async (req, res) => {
  const result = await db.run('DELETE FROM services WHERE key = ?', req.params.key);
  if (!result.changes) return res.status(404).json({ error: 'Service not found.' });
  res.json({ success: true, key: req.params.key });
});

app.get('/api/coverage/zones', requireAuth, requireStaff, async (req, res) => {
  res.json({ zones: await getZoneConfigurations(), updatedAt: new Date().toISOString() });
});

app.post('/api/coverage/zones', requireStaff, async (req, res) => {
  const zone = normalizeZoneInput(req.body || {});
  if (!zone.key || !zone.name || !zone.boundary) return res.status(400).json({ error: 'Key, region name, and boundary are required.' });
  if (await db.get('SELECT key FROM service_zones WHERE key = ?', zone.key)) return res.status(409).json({ error: 'A zone with this key already exists.' });
  await db.run('INSERT INTO service_zones (key, name, boundary, base_surcharge, distance_surcharge, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', zone.key, zone.name, zone.boundary, zone.baseSurcharge, zone.distanceSurcharge, zone.active, new Date().toISOString());
  res.status(201).json({ zone: (await getZoneConfigurations()).find((item) => item.key === zone.key) });
});

app.patch('/api/coverage/zones/:key', requireStaff, async (req, res) => {
  if (!await db.get('SELECT key FROM service_zones WHERE key = ?', req.params.key)) return res.status(404).json({ error: 'Zone not found.' });
  const zone = normalizeZoneInput(req.body || {}, req.params.key);
  if (!zone.name || !zone.boundary) return res.status(400).json({ error: 'Region name and boundary are required.' });
  await db.run('UPDATE service_zones SET name = ?, boundary = ?, base_surcharge = ?, distance_surcharge = ?, active = ?, updated_at = ? WHERE key = ?', zone.name, zone.boundary, zone.baseSurcharge, zone.distanceSurcharge, zone.active, new Date().toISOString(), req.params.key);
  res.json({ zone: (await getZoneConfigurations()).find((item) => item.key === req.params.key) });
});

app.delete('/api/coverage/zones/:key', requireStaff, async (req, res) => {
  const result = await db.run('DELETE FROM service_zones WHERE key = ?', req.params.key);
  if (!result.changes) return res.status(404).json({ error: 'Zone not found.' });
  res.json({ success: true, key: req.params.key });
});

app.get('/api/schedule', requireAuth, requireStaff, async (req, res) => {
  const date = String(req.query.date || 'today').trim().toLowerCase();
  const jobs = await getJobs();
  const columns = {
    queued: jobs.filter((job) => job.status === 'queued'),
    assigned: jobs.filter((job) => job.status === 'assigned'),
    completed: jobs.filter((job) => job.status === 'completed')
  };
  res.json({ date, columns, total: jobs.length, updatedAt: new Date().toISOString() });
});

app.get('/api/jobs', requireAuth, requireStaff, async (req, res) => {
  res.json({ jobs: await getJobs() });
});

app.get('/api/jobs/:id', requireAuth, requireStaff, async (req, res) => {
  const job = (await getJobs()).find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job, activity: (await getActivity()).filter((item) => item.detail.includes(job.id) || item.detail.includes(job.from) || item.detail.includes(job.to)).slice(0, 5) });
});

app.post('/api/quotes/estimate', async (req, res) => {
  const estimate = await calculateQuoteEstimate(req.body || {});
  res.json({ estimate, ok: true });
});

app.get('/api/quotes', requireAuth, requireStaff, async (req, res) => {
  res.json({ quotes: await getQuoteRecords() });
});

app.post('/api/quotes', requireAuth, requireStaff, async (req, res) => {
  const normalized = normalizeQuoteInput(req.body || {});
  const estimate = await calculateQuoteEstimate(normalized);
  const quote = await createQuoteRecord({ ...normalized, quoteTotal: estimate.total, status: 'pending' });
  res.status(201).json({ quote, estimate });
});

app.get('/api/bookings', requireAuth, requireStaff, async (req, res) => {
  res.json({ bookings: await getBookingRecords() });
});

app.get('/api/crm/customers', requireAuth, requireStaff, async (req, res) => {
  const customers = await buildCustomerDirectory();
  res.json({ customers, total: customers.length, updatedAt: new Date().toISOString() });
});

app.post('/api/bookings', async (req, res) => {
  const normalized = normalizeQuoteInput(req.body || {});
  const estimate = await calculateQuoteEstimate(normalized);
  const quote = await createQuoteRecord({ ...normalized, quoteTotal: estimate.total, status: 'accepted' });
  const booking = await createBookingRecord({ ...quote, status: 'booked', quoteTotal: estimate.total });
  res.status(201).json({ quote, booking, estimate });
});

app.post('/api/bookings/:id/dispatch', requireStaff, async (req, res) => {
  const booking = (await getBookingRecords()).find((item) => item.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.dispatchedJobId) {
    return res.status(409).json({ error: `Booking already dispatched as ${booking.dispatchedJobId}` });
  }

  const requestedVehicleId = req.body?.vehicleId ? String(req.body.vehicleId) : null;
  let vehicleId = null;
  if (requestedVehicleId) {
    const vehicles = await getVehicles();
    const vehicle = vehicles.find((item) => item.id === requestedVehicleId);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    if (vehicle.status !== 'available') {
      return res.status(409).json({ error: `Vehicle ${vehicle.plate} is not available (${vehicle.status})` });
    }
    vehicleId = vehicle.id;
  }

  const jobs = await getJobs();
  const nextNumber = jobs.length ? Math.max(...jobs.map((job) => Number(job.id.slice(3)))) + 1 : 9000;
  const serviceDate = booking.serviceDate ? new Date(`${booking.serviceDate}T12:00:00`) : new Date();
  const jobTime = !Number.isNaN(serviceDate.getTime()) && booking.serviceDate
    ? serviceDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : 'Today';
  const job = {
    id: `JO-${nextNumber}`,
    type: 'PICKUP',
    priority: 'Standard',
    from: booking.pickupAddress,
    to: booking.dropoffAddress,
    time: `${jobTime} · ${booking.serviceType.replace(/-/g, ' ')}`,
    distance: `${Number(booking.miles) || 0} mi`,
    price: `$${Number(booking.quoteTotal || 0).toFixed(2)}`,
    status: 'queued',
    lat: 37.75 + Math.random() * 0.08,
    lng: -122.44 + Math.random() * 0.07,
    toLat: 37.75 + Math.random() * 0.08,
    toLng: -122.44 + Math.random() * 0.07
  };
  await db.run('INSERT INTO jobs (id, type, priority, from_address, to_address, time, distance, price, status, driver, booking_id, vehicle_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    job.id, job.type, job.priority, job.from, job.to, job.time, job.distance, job.price, job.status, null, booking.id, vehicleId, new Date().toISOString());
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `dispatched ${booking.id}`, detail: `${booking.pickupAddress} to ${booking.dropoffAddress} · ${job.id}`, time: 'just now' });
  res.status(201).json({ job: { ...job, vehicleId }, message: `${booking.id} dispatched as ${job.id}` });
});

app.post('/api/purchase/lifetime', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });
  const email = String(req.body?.email || req.user.email || '').trim();
  if (!email || !isEmail(email)) return res.status(400).json({ error: 'A valid email is required' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: LIFETIME_CURRENCY,
          product_data: { name: 'RZ Dispatch Lifetime License', description: 'Permanent self-hosted use. No recurring subscription.' },
          unit_amount: LIFETIME_PRICE_CENTS
        },
        quantity: 1
      }],
      customer_email: email,
      metadata: { product: 'rz-dispatch', licenseType: 'lifetime', userId: req.user.id },
      success_url: `${PUBLIC_URL}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/?purchase=cancelled`
    });
    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Could not create lifetime checkout session:', error.message);
    res.status(502).json({ error: 'Could not start checkout' });
  }
});

app.get('/api/purchase/license', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });
  const sessionId = String(req.query.session_id || '');
  if (!sessionId || !sessionId.startsWith('cs_')) return res.status(400).json({ error: 'A valid checkout session is required' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const isLifetimePurchase = session.metadata?.product === 'rz-dispatch' && session.metadata?.licenseType === 'lifetime';
    if (!isLifetimePurchase || session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment has not been completed' });
    const license = await fulfillLifetimePurchase({ ...session, userId: req.user.id });
    res.json({ licenseKey: license.licenseKey, type: license.type, status: license.status });
  } catch (error) {
    res.status(404).json({ error: 'Purchase session not found' });
  }
});

app.post('/api/jobs', requireStaff, async (req, res) => {
  const { type, from, to } = req.body || {};
  if (!['pickup', 'delivery'].includes(String(type).toLowerCase()) || !isText(from) || !isText(to)) {
    return res.status(400).json({ error: 'type must be pickup or delivery; from and to are required' });
  }

  const jobs = await getJobs();
  const nextNumber = jobs.length ? Math.max(...jobs.map((job) => Number(job.id.slice(3)))) + 1 : 9000;
  const job = {
    id: `JO-${nextNumber}`,
    type: String(type).toUpperCase(),
    priority: 'Standard',
    from: from.trim(),
    to: to.trim(),
    time: 'Today, 11:20 AM',
    distance: 'Pending',
    price: 'Pending',
    status: 'queued',
    lat: 37.75 + Math.random() * 0.08,
    lng: -122.44 + Math.random() * 0.07,
    toLat: 37.75 + Math.random() * 0.08,
    toLng: -122.44 + Math.random() * 0.07
  };
  await db.run('INSERT INTO jobs (id, type, priority, from_address, to_address, time, distance, price, status, driver, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', job.id, job.type, job.priority, job.from, job.to, job.time, job.distance, job.price, job.status, null, new Date().toISOString());
  res.status(201).json({ job });
});

app.post('/api/jobs/:id/assign', requireStaff, async (req, res) => {
  const jobs = await getJobs();
  const job = jobs.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'assigned') return res.json({ job, message: `${job.id} is already assigned to ${job.driver}` });

  const requestedDriverId = String(req.body?.driverId || '').trim();
  const requestedVehicleId = String(req.body?.vehicleId || '').trim();

  const availableDrivers = await getDriverAvailability();
  const vehicles = await getVehicles();

  let driver = requestedDriverId ? availableDrivers.find((item) => item.id === requestedDriverId) : null;
  if (!driver && requestedDriverId) return res.status(409).json({ error: 'Selected driver is not available' });
  if (!driver) {
    driver = availableDrivers.find((item) => item.status === 'Available');
    if (!driver) return res.status(409).json({ error: 'No available drivers' });
  } else if (driver.status !== 'Available') {
    return res.status(409).json({ error: `${driver.name} is already on an active route` });
  }

  let vehicle = requestedVehicleId ? vehicles.find((item) => item.id === requestedVehicleId) : null;
  if (!vehicle && requestedVehicleId) return res.status(409).json({ error: 'Selected vehicle is not available' });
  if (!vehicle) {
    vehicle = vehicles.find((item) => item.status === 'available');
    if (!vehicle) return res.status(409).json({ error: 'No available vehicles' });
  } else if (vehicle.status !== 'available') {
    return res.status(409).json({ error: `${vehicle.plate} is not available (${vehicle.status})` });
  }

  await db.run('UPDATE jobs SET status = ?, driver = ?, vehicle_id = ? WHERE id = ?', 'assigned', driver.name, vehicle.id, job.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `assigned ${job.id}`, detail: `${driver.name} · ${vehicle.plate}`, time: 'just now' });
  const assignedJob = { ...job, status: 'assigned', driver: driver.name, vehicleId: vehicle.id, vehiclePlate: vehicle.plate, operatorDriverId: driver.id };
  realtime.broadcast('job.assigned', { job: assignedJob, message: `${job.id} assigned to ${driver.name}` }, ['staff', { type: 'driver', id: driver.id }]);
  res.json({ job: assignedJob, message: `${job.id} assigned to ${driver.name} (${vehicle.plate})` });
});

app.patch('/api/jobs/:id', requireStaff, async (req, res) => {
  const current = (await getJobs()).find((item) => item.id === req.params.id);
  if (!current) return res.status(404).json({ error: 'Job not found' });
  const body = req.body || {};
  const type = body.type === undefined ? current.type : String(body.type).toUpperCase();
  const from = body.from === undefined ? current.from : String(body.from).trim();
  const to = body.to === undefined ? current.to : String(body.to).trim();
  const priority = body.priority === undefined ? current.priority : String(body.priority).trim();
  const time = body.time === undefined ? current.time : String(body.time).trim();
  const status = body.status === undefined ? current.status : String(body.status).toLowerCase();
  if (!['PICKUP', 'DELIVERY'].includes(type) || !isText(from) || !isText(to) || !isText(priority) || !isText(time)) {
    return res.status(400).json({ error: 'type, route, priority, and schedule are required' });
  }
  if (!['queued', 'assigned', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid job status' });
  }
  await db.run('UPDATE jobs SET type = ?, priority = ?, from_address = ?, to_address = ?, time = ?, status = ? WHERE id = ?',
    type, priority, from, to, time, status, current.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `updated ${current.id}`, detail: `${from} to ${to}`, time: 'just now' });
  res.json({ job: (await getJobs()).find((item) => item.id === current.id), message: `${current.id} updated` });
});

app.delete('/api/jobs/:id', requireStaff, async (req, res) => {
  const current = (await getJobs()).find((item) => item.id === req.params.id);
  if (!current) return res.status(404).json({ error: 'Job not found' });
  const proofs = await db.all('SELECT file_path as filePath FROM proof_documents WHERE job_id = ?', current.id);
  proofs.forEach((proof) => {
    const proofPath = path.join(DATA_DIR, proof.filePath);
    if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
  });
  await db.run('DELETE FROM proof_documents WHERE job_id = ?', current.id);
  await db.run('DELETE FROM jobs WHERE id = ?', current.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `removed ${current.id}`, detail: `${current.from} to ${current.to}`, time: 'just now' });
  res.json({ success: true, id: current.id, message: `${current.id} removed` });
});

async function getVehiclesWithDrivers() {
  const vehicles = await getVehicles();
  const drivers = await getDrivers();
  return vehicles.map((vehicle) => ({
    ...vehicle,
    driverName: vehicle.driverId ? (drivers.find((driver) => driver.id === vehicle.driverId)?.name || null) : null
  }));
}

function normalizeVehicleInput(data = {}) {
  const plate = String(data.plate || '').trim().toUpperCase();
  const make = String(data.make || '').trim();
  const model = String(data.model || '').trim();
  const year = Number(data.year) || new Date().getFullYear();
  const vehicleType = String(data.vehicleType || 'sedan').trim().toLowerCase();
  const capacity = Math.max(1, Number(data.capacity) || 4);
  const status = String(data.status || 'available').trim().toLowerCase().replace(/\s+/g, '-');
  const mileage = Math.max(0, Number(data.mileage) || 0);
  const driverId = data.driverId ? String(data.driverId) : null;
  return { plate, make, model, year, vehicleType, capacity, status, mileage, driverId };
}

app.get('/api/vehicles', requireAuth, requireStaffOrOperator, async (req, res) => {
  res.json({ vehicles: await getVehiclesWithDrivers() });
});

app.post('/api/vehicles', requireStaff, async (req, res) => {
  const vehicle = normalizeVehicleInput(req.body || {});
  if (!vehicle.plate || !vehicle.make || !vehicle.model) {
    return res.status(400).json({ error: 'Plate, make, and model are required.' });
  }
  if (await db.get('SELECT id FROM vehicles WHERE plate = ?', vehicle.plate)) {
    return res.status(409).json({ error: 'A vehicle with this plate already exists.' });
  }
  const usedIds = new Set((await db.all('SELECT id FROM vehicles')).map((row) => row.id));
  let sequence = usedIds.size + 1;
  let id = `VH-${String(sequence).padStart(3, '0')}`;
  while (usedIds.has(id)) { sequence += 1; id = `VH-${String(sequence).padStart(3, '0')}`; }
  await db.run('INSERT INTO vehicles (id, plate, make, model, year, vehicle_type, capacity, status, driver_id, mileage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, vehicle.plate, vehicle.make, vehicle.model, vehicle.year, vehicle.vehicleType, vehicle.capacity, vehicle.status, vehicle.driverId, vehicle.mileage, new Date().toISOString());
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `added vehicle ${vehicle.plate}`, detail: `${vehicle.make} ${vehicle.model}`, time: 'just now' });
  res.status(201).json({ success: true, vehicle: (await getVehiclesWithDrivers()).find((v) => v.id === id) });
});

app.patch('/api/vehicles/:id', requireStaff, async (req, res) => {
  const current = await db.get('SELECT * FROM vehicles WHERE id = ?', req.params.id);
  if (!current) return res.status(404).json({ error: 'Vehicle not found' });
  const plate = String(req.body?.plate || current.plate).trim().toUpperCase();
  const make = String(req.body?.make || current.make).trim();
  const model = String(req.body?.model || current.model).trim();
  const year = Number(req.body?.year ?? current.year) || current.year;
  const vehicleType = String(req.body?.vehicleType || current.vehicle_type).trim().toLowerCase();
  const capacity = Math.max(1, Number(req.body?.capacity ?? current.capacity) || current.capacity);
  const status = String(req.body?.status || current.status).trim().toLowerCase().replace(' ', '-');
  const mileage = Math.max(0, Number(req.body?.mileage ?? current.mileage) || current.mileage);
  const driverId = req.body?.driverId === null ? null : String((req.body?.driverId ?? current.driver_id) || '') || null;
  if (!['available', 'on-route', 'off-duty', 'maintenance'].includes(status)) {
    return res.status(400).json({ error: 'Invalid vehicle status.' });
  }
  if (!plate || !make || !model) return res.status(400).json({ error: 'Plate, make, and model are required.' });
  await db.run('UPDATE vehicles SET plate = ?, make = ?, model = ?, year = ?, vehicle_type = ?, capacity = ?, status = ?, driver_id = ?, mileage = ? WHERE id = ?',
    plate, make, model, year, vehicleType, capacity, status, driverId, mileage, current.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `updated ${plate}`, detail: `${make} ${model}`, time: 'just now' });
  res.json({ success: true, vehicle: (await getVehiclesWithDrivers()).find((v) => v.id === current.id) });
});

app.delete('/api/vehicles/:id', requireStaff, async (req, res) => {
  const current = await db.get('SELECT id FROM vehicles WHERE id = ?', req.params.id);
  if (!current) return res.status(404).json({ error: 'Vehicle not found' });
  await db.run('DELETE FROM vehicles WHERE id = ?', current.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `removed vehicle ${current.id}`, detail: 'Fleet roster updated', time: 'just now' });
  res.json({ success: true, id: current.id, message: `${current.id} removed` });
});

app.get('/api/optimization/preview', requireAuth, requireStaff, async (req, res) => {
  const optimized = optimizeDispatchRoute(await getJobs());
  res.json({ jobs: optimized, count: optimized.length, strategy: 'Priority first, then known distance, then job ID.' });
});

app.get('/api/drivers', requireAuth, requireStaff, async (req, res) => {
  res.json({ drivers: await getDriverAvailability() });
});

app.post('/api/drivers', requireStaff, async (req, res) => {
  const driver = normalizeDriverInput(req.body || {});
  if (!driver.name) return res.status(400).json({ error: 'Driver name is required.' });
  const existing = await db.get('SELECT id FROM drivers WHERE name = ?', driver.name);
  if (existing) return res.status(409).json({ error: 'A driver with this name already exists.' });
  const usedIds = new Set((await db.all('SELECT id FROM drivers')).map((row) => row.id));
  let sequence = usedIds.size + 1;
  let id = `DR-${String(sequence).padStart(3, '0')}`;
  while (usedIds.has(id)) { sequence += 1; id = `DR-${String(sequence).padStart(3, '0')}`; }
  await db.run('INSERT INTO drivers (id, name, initials, phone, email, vehicle, status, rating, jobs_completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, driver.name, driver.initials, driver.phone, driver.email, driver.vehicle, driver.status, driver.rating, driver.jobs, new Date().toISOString());
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `added driver ${driver.name}`, detail: `${driver.vehicle || 'No vehicle'} · ${driver.status}`, time: 'just now' });
  res.status(201).json({ success: true, driver: (await getDrivers()).find((d) => d.id === id) });
});

app.patch('/api/drivers/:id', requireStaff, async (req, res) => {
  const current = await db.get('SELECT * FROM drivers WHERE id = ?', req.params.id);
  if (!current) return res.status(404).json({ error: 'Driver not found' });
  const body = req.body || {};
  const name = body.name === undefined ? current.name : String(body.name).trim();
  const initials = body.initials === undefined ? current.initials : String(body.initials).trim().toUpperCase();
  const phone = body.phone === undefined ? (current.phone || '') : String(body.phone).trim();
  const email = body.email === undefined ? (current.email || '') : String(body.email).trim().toLowerCase();
  const vehicle = body.vehicle === undefined ? (current.vehicle || '') : String(body.vehicle).trim();
  const status = body.status === undefined ? current.status : String(body.status).trim().replace(/\s+/g, ' ');
  const rating = body.rating === undefined ? current.rating : Math.min(5, Math.max(0, Number(body.rating) || 5));
  const jobs = body.jobs === undefined ? current.jobs_completed : Math.max(0, Number(body.jobs) || 0);
  if (!name) return res.status(400).json({ error: 'Driver name is required.' });
  if (!['Available', 'On route', 'Offline'].includes(status)) {
    return res.status(400).json({ error: 'Invalid driver status. Use Available, On route, or Offline.' });
  }
  const nameTaken = await db.get('SELECT id FROM drivers WHERE name = ? AND id != ?', name, current.id);
  if (nameTaken) return res.status(409).json({ error: 'A driver with this name already exists.' });
  await db.run('UPDATE drivers SET name = ?, initials = ?, phone = ?, email = ?, vehicle = ?, status = ?, rating = ?, jobs_completed = ? WHERE id = ?',
    name, initials, phone, email, vehicle, status, rating, jobs, current.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `updated driver ${name}`, detail: `Status: ${status}`, time: 'just now' });
  res.json({ success: true, driver: (await getDrivers()).find((d) => d.id === current.id) });
});

app.delete('/api/drivers/:id', requireStaff, async (req, res) => {
  const current = await db.get('SELECT id FROM drivers WHERE id = ?', req.params.id);
  if (!current) return res.status(404).json({ error: 'Driver not found' });
  const active = await db.get("SELECT COUNT(*) as count FROM jobs WHERE status IN ('assigned','en_route','arrived','picked_up') AND driver = (SELECT name FROM drivers WHERE id = ?)", current.id);
  if (Number(active.count) > 0) return res.status(409).json({ error: 'Cannot remove a driver with active jobs.' });
  await db.run('DELETE FROM drivers WHERE id = ?', current.id);
  await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: `removed driver ${current.id}`, detail: 'Roster updated', time: 'just now' });
  res.json({ success: true, id: current.id, message: `${current.id} removed` });
});

app.post('/api/optimization/apply', requireStaff, async (req, res) => {
  const optimized = optimizeDispatchRoute(await getJobs());
  await db.transaction(async (tx) => {
    await tx.run('UPDATE jobs SET route_order = NULL WHERE status NOT IN (?, ?)', 'queued', 'assigned');
    for (const job of optimized) {
      await tx.run('UPDATE jobs SET route_order = ? WHERE id = ?', job.routeOrder, job.id);
    }
  });
  if (optimized.length) await activityPush({ initials: 'RZ', name: staffDisplayName(req.user), action: 'optimized dispatch route', detail: `${optimized.length} active loads sequenced`, time: 'just now' });
  res.json({ success: true, jobs: optimized, count: optimized.length, message: optimized.length ? `Route optimized for ${optimized.length} active loads` : 'No active loads to optimize' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
// Express error middleware: always answer the front end with JSON, never an
// HTML error page (which the browser would fail to parse as JSON).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[backend] Request error:', err?.message || err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

if (require.main === module) {
  const { ensureDatabase } = require('./scripts/ensure-database');
  (async () => {
    await ensureDatabase();
    await initializeDatabase();
    const server = app.listen(PORT, HOST, () => {
      console.log(`RZ Dispatch SaaS running at http://${HOST}:${PORT}`);
    });
    realtime.attachRealtime(server, { jwtSecret: JWT_SECRET });
    // If another backend already owns the port (e.g. a detached orphan from a
    // previous session), report it clearly instead of silently dying.
    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use - another RZ Dispatch backend is probably running.`);
        process.exit(1);
      } else {
        console.error('Failed to start server:', error?.message || error);
        process.exit(1);
      }
    });
  })().catch((error) => {
    console.error('Failed to start RZ Dispatch:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  app,
  realtime,
  stripe,
  handleStripeWebhook,
  initializeDatabase,
  signToken,
  generateLicenseKey,
  validateLicenseKey,
  normalizeLicenseKey,
  createLicenseRecord,
  revokeLicense,
  findLicenseRecord,
  hasValidLicense,
  getLicenseKeyFromRequest,
  isEmail,
  isText,
  requireAuth,
  requireActiveLicense,
  getJobs,
  optimizeDispatchRoute,
  getDrivers,
  getActivity,
  getServiceConfigurations,
  normalizeServiceInput,
  getZoneConfigurations,
  normalizeZoneInput,
  calculateQuoteEstimate,
  createQuoteRecord,
  getQuoteRecords,
  createBookingRecord,
  getBookingRecords,
  buildCustomerDirectory,
  lookupCustomerOrder,
  buildAccountSummary,
  getAdminOverview,
  buildBillingSummary,
  createEmailVerificationToken,
  verifyEmailToken,
  getVehicles
};

async function initializeDatabase() {
  // Schema. Each statement runs separately: PostgreSQL rejects multiple
  // commands in one prepared statement. `active` / `is_read` stay SMALLINT
  // flags (0/1) so the existing `active = 1` / `is_read = 0` queries keep
  // working exactly as they did on SQLite.
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      driver_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      notify_email SMALLINT NOT NULL DEFAULT 1,
      notify_sms SMALLINT NOT NULL DEFAULT 0,
      notify_inapp SMALLINT NOT NULL DEFAULT 1,
      locale TEXT,
      currency TEXT,
      timezone TEXT,
      country TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS customer_addresses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      line_one TEXT,
      line_two TEXT,
      city TEXT,
      region TEXT,
      postal_code TEXT,
      country TEXT,
      phone TEXT,
      is_default SMALLINT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
type TEXT NOT NULL,
      priority TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      time TEXT NOT NULL,
      distance TEXT NOT NULL,
      price TEXT NOT NULL,
      status TEXT NOT NULL,
      driver TEXT,
      route_order INTEGER,
      booking_id TEXT,
      vehicle_id TEXT,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      license_key TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      stripe_session_id TEXT,
      customer_email TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      initials TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      time TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      initials TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL,
      customer_email TEXT,
      customer_name TEXT,
      is_read SMALLINT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS services (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      base_price DOUBLE PRECISION NOT NULL,
      distance_rate DOUBLE PRECISION NOT NULL,
      hourly_rate DOUBLE PRECISION NOT NULL,
      active SMALLINT NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS service_zones (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      boundary TEXT NOT NULL,
      base_surcharge DOUBLE PRECISION NOT NULL,
      distance_surcharge DOUBLE PRECISION NOT NULL,
      active SMALLINT NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      service_type TEXT NOT NULL,
      pickup_address TEXT NOT NULL,
      dropoff_address TEXT NOT NULL,
      service_date TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      miles DOUBLE PRECISION NOT NULL,
      passengers INTEGER NOT NULL,
      hours INTEGER NOT NULL,
      notes TEXT,
      quote_total DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      service_type TEXT NOT NULL,
      pickup_address TEXT NOT NULL,
      dropoff_address TEXT NOT NULL,
      service_date TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      miles DOUBLE PRECISION NOT NULL,
      passengers INTEGER NOT NULL,
      hours INTEGER NOT NULL,
      notes TEXT,
      quote_total DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS proof_documents (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      plate TEXT NOT NULL,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER NOT NULL,
      vehicle_type TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      driver_id TEXT,
      mileage INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      initials TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      vehicle TEXT,
      status TEXT NOT NULL DEFAULT 'Available',
      rating DOUBLE PRECISION NOT NULL DEFAULT 5.0,
      jobs_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    // Legacy migrations (already present in the CREATE TABLE statements above
    // for fresh installs, but kept idempotent for pre-existing databases).
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS route_order INTEGER`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS booking_id TEXT`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS vehicle_id TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS customer_email TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS operator_driver_id TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS operator_name TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_driver_id TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS customer_name TEXT`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS country TEXT`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS locale TEXT`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS currency TEXT`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timezone TEXT`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_inapp INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vehicle_type TEXT`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS passengers INTEGER NOT NULL DEFAULT 1`
  ];

  // Detect whether the admin-approval `status` column already exists BEFORE
  // the schema statements below run. If it does not exist yet, every account
  // present at that moment is a pre-approval user and is backfilled to
  // 'approved' so upgrading never locks out current accounts. This runs once:
  // afterwards the column exists and `status` is managed by the auth flow.
  const statusColumnExisted = await db.get(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'status'`);

  for (const statement of statements) {
    await db.exec(statement);
  }

  // One-time backfill for databases that just gained the `status` column.
  if (!statusColumnExisted) {
    await db.run(`UPDATE users SET status = 'approved'`);
  }

  const adminExisting = await db.get('SELECT id FROM users WHERE email = ?', ADMIN_EMAIL);
  if (!adminExisting) {
    await db.run('INSERT INTO users (id, email, password_hash, role, driver_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(), ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12), 'admin', null, 'approved', new Date().toISOString());
  }

  const operatorExisting = await db.get('SELECT id, driver_id as driverId FROM users WHERE email = ?', OPERATOR_EMAIL);
  if (!operatorExisting) {
    await db.run('INSERT INTO users (id, email, password_hash, role, driver_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(), OPERATOR_EMAIL, bcrypt.hashSync(OPERATOR_PASSWORD, 12), 'operator', OPERATOR_DRIVER_ID, 'approved', new Date().toISOString());
  } else if (!operatorExisting.driverId) {
    // Backfill: an operator account created before the driver_id column existed would
    // otherwise fail the requireOperator guard with "Operator access required."
    await db.run('UPDATE users SET driver_id = ? WHERE id = ?', OPERATOR_DRIVER_ID, operatorExisting.id);
  }

  const jobsCount = Number((await db.get('SELECT COUNT(*) as count FROM jobs'))?.count || 0);
  if (jobsCount === 0) {
    for (const job of defaultJobs) {
      await db.run('INSERT INTO jobs (id, type, priority, from_address, to_address, time, distance, price, status, driver, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        job.id, job.type, job.priority, job.from, job.to, job.time, job.distance, job.price, job.status, null, new Date().toISOString());
    }
  }

  const activityCount = Number((await db.get('SELECT COUNT(*) as count FROM activity'))?.count || 0);
  if (activityCount === 0) {
    for (const item of defaultActivity) {
      await db.run('INSERT INTO activity (id, initials, name, action, detail, time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), item.initials, item.name, item.action, item.detail, item.time, new Date().toISOString());
    }
  }

  const messageCount = Number((await db.get('SELECT COUNT(*) as count FROM messages'))?.count || 0);
  if (messageCount === 0) {
    for (let index = 0; index < defaultMessages.length; index++) {
      const message = defaultMessages[index];
      await db.run('INSERT INTO messages (id, sender, initials, subject, body, type, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), message.sender, message.initials, message.subject, message.body, message.type, index === 2 ? 1 : 0, new Date(Date.now() - index * 600000).toISOString());
    }
  }

  const serviceCount = Number((await db.get('SELECT COUNT(*) as count FROM services'))?.count || 0);
  if (serviceCount === 0) {
    for (const service of defaultServices) {
      await db.run('INSERT INTO services (key, name, description, base_price, distance_rate, hourly_rate, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        service.key, service.name, service.description, service.basePrice, service.distanceRate, service.hourlyRate, service.active, new Date().toISOString());
    }
  }

  const zoneCount = Number((await db.get('SELECT COUNT(*) as count FROM service_zones'))?.count || 0);
  if (zoneCount === 0) {
    for (const zone of defaultZones) {
      await db.run('INSERT INTO service_zones (key, name, boundary, base_surcharge, distance_surcharge, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        zone.key, zone.name, zone.boundary, zone.baseSurcharge, zone.distanceSurcharge, zone.active, new Date().toISOString());
    }
  }

const vehicleCount = Number((await db.get('SELECT COUNT(*) as count FROM vehicles'))?.count || 0);
  if (vehicleCount === 0) {
    for (const vehicle of defaultVehicles) {
      await db.run('INSERT INTO vehicles (id, plate, make, model, year, vehicle_type, capacity, status, driver_id, mileage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        vehicle.id, vehicle.plate, vehicle.make, vehicle.model, vehicle.year, vehicle.vehicleType, vehicle.capacity, vehicle.status, vehicle.driverId, vehicle.mileage, new Date().toISOString());
    }
  }

  const driverCount = Number((await db.get('SELECT COUNT(*) as count FROM drivers'))?.count || 0);
  if (driverCount === 0) {
    for (const driver of defaultDrivers) {
      await db.run('INSERT INTO drivers (id, name, initials, phone, email, vehicle, status, rating, jobs_completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        driver.id, driver.name, driver.initials, '', '', driver.vehicle, driver.status, driver.rating, driver.jobs, new Date().toISOString());
    }
  }

  if (require.main === module) {
    try {
      const { runMigrations } = require('./scripts/migrate');
      await runMigrations();
    } catch (migrationError) {
      console.error('[migrate] migration runner failed during initialize:', migrationError?.message || migrationError);
    }
  }
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.get('SELECT id, email, role, driver_id as driverId, status FROM users WHERE id = ?', decoded.id || decoded.sub);
    if (!user) return res.status(401).json({ error: 'Invalid session.' });
    // Admin approval workflow: a pending/rejected account's existing token is
    // worthless, even if it was issued before the status changed.
    if (user.status === 'pending') return res.status(403).json({ error: 'Your account is currently awaiting admin approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Your registration request was declined.' });
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Session expired or invalid.' });
  }
}

function requireCustomer(req, res, next) {
  if (!req.user || req.user.role !== 'customer') return res.status(403).json({ error: 'Customer access required.' });
  next();
}

function requireStaff(req, res, next) {
  if (!req.user || !['admin', 'owner'].includes(req.user.role)) return res.status(403).json({ error: 'Staff access required.' });
  next();
}

function requireOperator(req, res, next) {
  if (!req.user || req.user.role !== 'operator' || !req.user.driverId) return res.status(403).json({ error: 'Operator access required.' });
  next();
}

// Dispatchers (admin/owner) and linked operators both need read access to
// shared dispatch data such as the vehicle list.
function requireStaffOrOperator(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Staff access required.' });
  if (['admin', 'owner'].includes(req.user.role)) return next();
  if (req.user.role === 'operator' && req.user.driverId) return next();
  res.status(403).json({ error: 'Staff access required.' });
}

async function driverDisplayName(user) {
  return (await getDrivers()).find((driver) => driver.id === user.driverId)?.name || user.email;
}

function staffDisplayName(user) {
  return String(user.email || 'Dispatcher').split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Dispatcher';
}

async function getOperatorJob(user, id) {
  const driverName = await driverDisplayName(user);
  return (await getJobs()).find((job) => job.id === id && job.driver === driverName);
}

async function requireActiveLicense(req, res, next) {
  if (!REQUIRE_LICENSE) return next();
  if (await hasValidLicense(req.user)) return next();
  return res.status(402).json({ error: 'License required', licenseRequired: true, message: 'Activate your RZ Dispatch license to continue.' });
}

async function getJobs() {
  const rows = await db.all('SELECT id, type, priority, from_address, to_address, time, distance, price, status, driver, route_order, booking_id, vehicle_id FROM jobs ORDER BY CASE WHEN route_order IS NULL THEN 1 ELSE 0 END, route_order ASC, created_at DESC');
  const coordMap = new Map(defaultJobs.map((job) => [job.id, { lat: job.lat, lng: job.lng, toLat: job.toLat, toLng: job.toLng }]));
  return rows.map((job) => {
    const coords = coordMap.get(job.id);
    return {
      ...job,
      from: job.from_address,
      to: job.to_address,
      routeOrder: job.route_order,
      bookingId: job.booking_id,
      vehicleId: job.vehicle_id,
      lat: coords?.lat ?? (37.75 + Math.random() * 0.08),
      lng: coords?.lng ?? (-122.44 + Math.random() * 0.07),
      toLat: coords?.toLat ?? (37.75 + Math.random() * 0.08),
      toLng: coords?.toLng ?? (-122.44 + Math.random() * 0.07)
    };
  });
}

function optimizeDispatchRoute(jobs) {
  const priorityRank = { Urgent: 0, 'High priority': 1, Standard: 2 };
  const distanceValue = (job) => {
    const value = Number.parseFloat(String(job.distance).replace(/[^0-9.]/g, ''));
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return [...jobs]
    .filter((job) => ['queued', 'assigned'].includes(job.status))
    .sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3) || distanceValue(a) - distanceValue(b) || a.id.localeCompare(b.id))
    .map((job, index) => ({ ...job, routeOrder: index + 1, optimizationReason: `${job.priority}; ${distanceValue(job) === Number.MAX_SAFE_INTEGER ? 'distance pending' : `${distanceValue(job)} mi`}` }));
}

async function getDriverAvailability() {
  const rows = await db.all("SELECT driver, COUNT(*) AS active FROM jobs WHERE status IN ('assigned','en_route','arrived','picked_up') AND driver IS NOT NULL GROUP BY driver");
  const activeByDriver = new Map(rows.map((row) => [row.driver, Number(row.active)]));
  const drivers = await getDrivers();
  return drivers.map((driver) => ({
    ...driver,
    status: driver.status === 'Offline' ? 'Offline' : (activeByDriver.has(driver.name) ? 'On route' : 'Available'),
    jobs: Number(activeByDriver.get(driver.name) ?? 0) || Number(driver.jobs) || 0
  }));
}

async function getDrivers() {
  const rows = await db.all("SELECT id, name, initials, phone, email, vehicle, status, rating, jobs_completed as jobs, created_at as createdAt FROM drivers ORDER BY CASE WHEN status = 'Available' THEN 0 ELSE 1 END, created_at ASC");
  return rows.map((driver) => ({ ...driver, rating: Number(driver.rating) || 5 }));
}

function normalizeDriverInput(data = {}) {
  const name = String(data.name || '').trim();
  const initials = String(data.initials || '').trim().toUpperCase();
  const phone = String(data.phone || '').trim();
  const email = String(data.email || '').trim().toLowerCase();
  const vehicle = String(data.vehicle || '').trim();
  const status = String(data.status || 'Available').trim().replace(/\s+/g, ' ');
  const rating = Math.min(5, Math.max(0, Number(data.rating) || 5));
  const jobs = Math.max(0, Number(data.jobs) || 0);
  return { name, initials, phone, email, vehicle, status, rating, jobs };
}

async function getVehicles() {
  const vehicles = await db.all('SELECT id, plate, make, model, year, vehicle_type as vehicleType, capacity, status, driver_id as driverId, mileage, created_at as createdAt FROM vehicles ORDER BY created_at ASC');
  const activeRows = await db.all("SELECT vehicle_id, COUNT(*) AS active FROM jobs WHERE status IN ('assigned','en_route','arrived','picked_up') AND vehicle_id IS NOT NULL GROUP BY vehicle_id");
  const reservedRows = await db.all("SELECT vehicle_id, COUNT(*) AS reserved FROM jobs WHERE status IN ('queued') AND vehicle_id IS NOT NULL GROUP BY vehicle_id");
  const activeByVehicle = new Map(activeRows.map((row) => [row.vehicle_id, Number(row.active)]));
  const reservedByVehicle = new Map(reservedRows.map((row) => [row.vehicle_id, Number(row.reserved)]));
  return vehicles.map((vehicle) => {
    const active = Number(activeByVehicle.get(vehicle.id) ?? 0);
    const reserved = Number(reservedByVehicle.get(vehicle.id) ?? 0);
    return {
      ...vehicle,
      active,
      reserved: reserved || 0,
      status: active > 0 ? 'on-route' : (reserved > 0 ? 'reserved' : vehicle.status)
    };
  });
}

async function getActivity() {
  return db.all('SELECT initials, name, action, detail, time FROM activity ORDER BY created_at DESC LIMIT 10');
}

async function getServiceConfigurations() {
  return (await db.all('SELECT key, name, description, base_price as basePrice, distance_rate as distanceRate, hourly_rate as hourlyRate, active, updated_at as updatedAt FROM services ORDER BY name ASC')).map((service) => ({ ...service, basePrice: Number(service.basePrice), distanceRate: Number(service.distanceRate), hourlyRate: Number(service.hourlyRate), active: Boolean(service.active) }));
}

function normalizeServiceInput(data = {}, fallbackKey = '') {
  const key = String(data.key || fallbackKey).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return { key, name: String(data.name || '').trim(), description: String(data.description || '').trim(), basePrice: Math.max(0, Number(data.basePrice) || 0), distanceRate: Math.max(0, Number(data.distanceRate) || 0), hourlyRate: Math.max(0, Number(data.hourlyRate) || 0), active: data.active === undefined ? 1 : (data.active === true || data.active === 'true' || data.active === 'on' || data.active === 1 ? 1 : 0) };
}

async function getZoneConfigurations() {
  return (await db.all('SELECT key, name, boundary, base_surcharge as baseSurcharge, distance_surcharge as distanceSurcharge, active, updated_at as updatedAt FROM service_zones ORDER BY name ASC')).map((zone) => ({ ...zone, baseSurcharge: Number(zone.baseSurcharge), distanceSurcharge: Number(zone.distanceSurcharge), active: Boolean(zone.active) }));
}

function normalizeZoneInput(data = {}, fallbackKey = '') {
  const key = String(data.key || fallbackKey).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return { key, name: String(data.name || '').trim(), boundary: String(data.boundary || '').trim(), baseSurcharge: Math.max(0, Number(data.baseSurcharge) || 0), distanceSurcharge: Math.max(0, Number(data.distanceSurcharge) || 0), active: data.active === undefined ? 1 : (data.active === true || data.active === 'true' || data.active === 'on' || data.active === 1 ? 1 : 0) };
}

async function calculateQuoteEstimate({ serviceType, vehicleType, miles, passengers, hours = 1 } = {}) {
  const service = String(serviceType || 'same-day').toLowerCase();
  const vehicle = String(vehicleType || 'car').toLowerCase();
  const distance = Number(miles) || 0;
  const seats = Math.max(1, Number(passengers) || 1);
  const duration = Math.max(1, Number(hours) || 1);

  const baseByService = {
    'same-day': 45,
    'airport-transfer': 68,
    hourly: 55,
    charter: 110
  };
  const vehicleMultiplier = {
    car: 1,
    suv: 1.35,
    van: 1.7,
    luxury: 2.1
  };

  const configuredService = await db.get('SELECT base_price, distance_rate FROM services WHERE key = ? AND active = 1', service);
  const base = Number(configuredService?.base_price ?? baseByService[service] ?? 52);
  const serviceDistanceRate = Number(configuredService?.distance_rate ?? 1.35);
  const distanceRate = distance * serviceDistanceRate * (vehicle === 'van' ? 1.6 : vehicle === 'suv' ? 1.35 : vehicle === 'luxury' ? 1.85 : 1);
  const passengerSurcharge = Math.max(0, seats - 1) * 12;
  const durationMultiplier = Math.max(1, duration / 2);
  const subtotal = (base + distanceRate + passengerSurcharge) * durationMultiplier * (vehicleMultiplier[vehicle] || 1);
  const serviceFee = subtotal * 0.12;
  const tax = (subtotal + serviceFee) * 0.08;
  const total = subtotal + serviceFee + tax;

  return {
    status: 'ready',
    currency: 'USD',
    serviceType: service,
    vehicleType: vehicle,
    miles: Number(distance.toFixed(2)),
    passengers: seats,
    hours: duration,
    breakdown: {
      base: Number(base.toFixed(2)),
      distanceRate: Number(distanceRate.toFixed(2)),
      passengerSurcharge: Number(passengerSurcharge.toFixed(2)),
      serviceFee: Number(serviceFee.toFixed(2)),
      tax: Number(tax.toFixed(2))
    },
    subtotal: Number(subtotal.toFixed(2)),
    total: Number(total.toFixed(2))
  };
}

function normalizeQuoteInput(data = {}) {
  const payload = data || {};
  return {
    customerName: String(payload.customerName || '').trim(),
    email: String(payload.email || '').trim(),
    phone: String(payload.phone || '').trim(),
    serviceType: String(payload.serviceType || 'same-day').trim(),
    pickupAddress: String(payload.pickupAddress || '').trim(),
    dropoffAddress: String(payload.dropoffAddress || '').trim(),
    serviceDate: String(payload.serviceDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10)),
    vehicleType: String(payload.vehicleType || 'car').trim(),
    miles: Number(payload.miles || 0),
    passengers: Math.max(1, Number(payload.passengers || 1)),
    hours: Math.max(1, Number(payload.hours || 1)),
    notes: String(payload.notes || '').trim()
  };
}

async function createQuoteRecord({ customerName, email, phone, serviceType, pickupAddress, dropoffAddress, serviceDate, vehicleType, miles, passengers, hours, notes, quoteTotal, status = 'pending' } = {}) {
  const record = {
    id: `Q-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    customerName: String(customerName || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    serviceType: String(serviceType || 'same-day').trim(),
    pickupAddress: String(pickupAddress || '').trim(),
    dropoffAddress: String(dropoffAddress || '').trim(),
    serviceDate: String(serviceDate || new Date().toISOString().slice(0, 10)),
    vehicleType: String(vehicleType || 'car').trim(),
    miles: Number(miles) || 0,
    passengers: Math.max(1, Number(passengers) || 1),
    hours: Math.max(1, Number(hours) || 1),
    notes: String(notes || '').trim(),
    quoteTotal: Number(quoteTotal) || 0,
    status,
    createdAt: new Date().toISOString()
  };

  await db.run('INSERT INTO quotes (id, customer_name, email, phone, service_type, pickup_address, dropoff_address, service_date, vehicle_type, miles, passengers, hours, notes, quote_total, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    record.id, record.customerName, record.email, record.phone, record.serviceType, record.pickupAddress, record.dropoffAddress, record.serviceDate, record.vehicleType, record.miles, record.passengers, record.hours, record.notes, record.quoteTotal, record.status, record.createdAt);

  return record;
}

async function getQuoteRecords() {
  return (await db.all('SELECT * FROM quotes ORDER BY created_at DESC')).map((quote) => ({
    id: quote.id,
    customerName: quote.customer_name,
    email: quote.email,
    phone: quote.phone,
    serviceType: quote.service_type,
    pickupAddress: quote.pickup_address,
    dropoffAddress: quote.dropoff_address,
    serviceDate: quote.service_date,
    vehicleType: quote.vehicle_type,
    miles: quote.miles,
    passengers: quote.passengers,
    hours: quote.hours,
    notes: quote.notes,
    quoteTotal: Number(quote.quote_total),
    status: quote.status,
    createdAt: quote.created_at
  }));
}

async function createBookingRecord({ id, quoteId, customerName, email, phone, serviceType, pickupAddress, dropoffAddress, serviceDate, vehicleType, miles, passengers, hours, notes, quoteTotal, status = 'booked' } = {}) {
  const record = {
    id: `BK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    quoteId: quoteId || id || null,
    customerName: String(customerName || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    serviceType: String(serviceType || 'same-day').trim(),
    pickupAddress: String(pickupAddress || '').trim(),
    dropoffAddress: String(dropoffAddress || '').trim(),
    serviceDate: String(serviceDate || new Date().toISOString().slice(0, 10)),
    vehicleType: String(vehicleType || 'car').trim(),
    miles: Number(miles) || 0,
    passengers: Math.max(1, Number(passengers) || 1),
    hours: Math.max(1, Number(hours) || 1),
    notes: String(notes || '').trim(),
    quoteTotal: Number(quoteTotal) || 0,
    status,
    createdAt: new Date().toISOString()
  };

  await db.run('INSERT INTO bookings (id, quote_id, customer_name, email, phone, service_type, pickup_address, dropoff_address, service_date, vehicle_type, miles, passengers, hours, notes, quote_total, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    record.id, record.quoteId, record.customerName, record.email, record.phone, record.serviceType, record.pickupAddress, record.dropoffAddress, record.serviceDate, record.vehicleType, record.miles, record.passengers, record.hours, record.notes, record.quoteTotal, record.status, record.createdAt);

  return record;
}

async function getBookingRecords() {
  const jobs = await db.all("SELECT id, booking_id FROM jobs WHERE booking_id IS NOT NULL");
  const jobByBooking = new Map(jobs.map((job) => [job.booking_id, job.id]));
  return (await db.all('SELECT * FROM bookings ORDER BY created_at DESC')).map((booking) => ({
    id: booking.id,
    quoteId: booking.quote_id,
    customerName: booking.customer_name,
    email: booking.email,
    phone: booking.phone,
    serviceType: booking.service_type,
    pickupAddress: booking.pickup_address,
    dropoffAddress: booking.dropoff_address,
    serviceDate: booking.service_date,
    vehicleType: booking.vehicle_type,
    miles: booking.miles,
    passengers: booking.passengers,
    hours: booking.hours,
    notes: booking.notes,
    quoteTotal: Number(booking.quote_total),
    status: booking.status,
    dispatchedJobId: jobByBooking.get(booking.id) || null,
    createdAt: booking.created_at
  }));
}

async function buildCustomerDirectory() {
  const quotes = await getQuoteRecords();
  const bookings = await getBookingRecords();
  const byEmail = new Map();
  const addCustomerRecord = (record, kind) => {
    const email = record.email.toLowerCase();
    if (!email) return;
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        id: `CUS-${crypto.createHash('sha1').update(email).digest('hex').slice(0, 8).toUpperCase()}`,
        name: record.customerName,
        email: record.email,
        phone: record.phone,
        totalSpend: 0,
        bookings: 0,
        quotes: 0,
        lastContact: record.createdAt,
        history: []
      });
    }
    const customer = byEmail.get(email);
    customer.name = record.customerName || customer.name;
    customer.phone = record.phone || customer.phone;
    customer.lastContact = new Date(record.createdAt) > new Date(customer.lastContact) ? record.createdAt : customer.lastContact;
    customer.history.push({ id: record.id, kind, status: record.status, serviceType: record.serviceType, date: record.serviceDate, route: `${record.pickupAddress} → ${record.dropoffAddress}`, total: record.quoteTotal, createdAt: record.createdAt });
    if (kind === 'booking') {
      customer.bookings += 1;
      customer.totalSpend += record.quoteTotal;
    } else {
      customer.quotes += 1;
    }
  };
  quotes.forEach((quote) => addCustomerRecord(quote, 'quote'));
  bookings.forEach((booking) => addCustomerRecord(booking, 'booking'));
  return [...byEmail.values()].map((customer) => ({ ...customer, totalSpend: Number(customer.totalSpend.toFixed(2)), history: customer.history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) })).sort((a, b) => new Date(b.lastContact) - new Date(a.lastContact));
}

function trackingPhaseForJob(status) {
  const phases = {
    delivered: { step: 'Delivered', progress: 100, message: 'Your trip is complete.', etaLabel: null },
    completed: { step: 'Completed', progress: 100, message: 'Your trip is complete.', etaLabel: null },
    picked_up: { step: 'On the way to your destination', progress: 90, message: 'Your driver is heading to the dropoff now.', etaLabel: 'ETA 15 min' },
    arrived: { step: 'At your pickup point', progress: 70, message: 'Your driver has arrived and is waiting for you.', etaLabel: 'At pickup' },
    en_route: { step: 'Driver en route to pickup', progress: 50, message: 'Your driver is on the way to you now.', etaLabel: 'Arriving in about 20 min' },
    assigned: { step: 'Driver assigned', progress: 40, message: 'Your driver is assigned and preparing for the trip.', etaLabel: 'Departs soon' },
    queued: { step: 'On our schedule', progress: 25, message: 'Your booking is queued for dispatch.', etaLabel: null }
  };
  return phases[status] || null;
}

async function geocodeAddress(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, {
      headers: { 'User-Agent': 'RZDispatch-CustomerPortal/2.0 (contact: support@rzdispatch.local)', 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return [null, null];
    const results = await response.json();
    const first = Array.isArray(results) && results[0];
    if (!first) return [null, null];
    return [Number(first.lat), Number(first.lon)];
  } catch (error) {
    return [null, null];
  } finally {
    clearTimeout(timer);
  }
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function estimateRouteMiles(from, to) {
  const [fromLat, fromLon] = await geocodeAddress(from);
  if (fromLat == null) return null;
  const [toLat, toLon] = await geocodeAddress(to);
  if (toLat == null) return null;
  const roadFactor = 1.25;
  const miles = haversineMiles(fromLat, fromLon, toLat, toLon) * roadFactor;
  return Math.max(1, Math.round(miles));
}

async function lookupCustomerOrder({ orderId, email } = {}) {
  const normalizedId = String(orderId || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedId || !normalizedEmail) return null;

  const quote = await db.get('SELECT * FROM quotes WHERE id = ? AND LOWER(email) = ?', normalizedId, normalizedEmail);
  if (quote) {
    return {
      kind: 'quote',
      id: quote.id,
      email: quote.email,
      status: quote.status,
      customerName: quote.customer_name,
      serviceType: quote.service_type,
      pickupAddress: quote.pickup_address,
      dropoffAddress: quote.dropoff_address,
      serviceDate: quote.service_date,
      vehicleType: quote.vehicle_type,
      miles: Number(quote.miles),
      passengers: Number(quote.passengers),
      hours: Number(quote.hours),
      phone: quote.phone,
      quoteTotal: Number(quote.quote_total),
      notes: quote.notes,
      createdAt: quote.created_at,
      driver: null,
      vehicle: null,
      tracking: {
        step: quote.status === 'accepted' ? 'Confirmed' : quote.status === 'pending' ? 'Awaiting review' : 'Completed',
        progress: quote.status === 'accepted' ? 60 : quote.status === 'pending' ? 30 : 100,
        message: quote.status === 'accepted' ? 'Your booking is confirmed and on our schedule.' : quote.status === 'pending' ? 'We are reviewing your request and will confirm shortly.' : 'Your trip is complete.',
        etaLabel: null
      }
    };
  }

  const booking = await db.get('SELECT * FROM bookings WHERE id = ? AND LOWER(email) = ?', normalizedId, normalizedEmail);
  if (booking) {
    const jobs = await getJobs();
    const job = jobs.find((item) => item.bookingId === booking.id);
    const drivers = job?.driver ? await getDriverAvailability() : [];
    const driverRecord = drivers.find((driver) => driver.name === job.driver);
    const vehicles = job?.vehicleId ? await getVehicles() : [];
    const vehicleRecord = vehicles.find((v) => v.id === job.vehicleId);
    const jobPhase = job ? trackingPhaseForJob(job.status) : null;

    return {
      kind: 'booking',
      id: booking.id,
      email: booking.email,
      status: booking.status,
      customerName: booking.customer_name,
      serviceType: booking.service_type,
      pickupAddress: booking.pickup_address,
      dropoffAddress: booking.dropoff_address,
      serviceDate: booking.service_date,
      vehicleType: booking.vehicle_type,
      miles: Number(booking.miles),
      passengers: Number(booking.passengers),
      hours: Number(booking.hours),
      phone: booking.phone,
      quoteTotal: Number(booking.quote_total),
      notes: booking.notes,
      createdAt: booking.created_at,
      driver: jobPhase && driverRecord ? { name: driverRecord.name, phone: driverRecord.phone || null } : null,
      vehicle: jobPhase && vehicleRecord ? { label: `${vehicleRecord.make} ${vehicleRecord.model}`, plate: vehicleRecord.plate } : null,
      tracking: jobPhase || {
        step: booking.status === 'booked' ? 'Confirmed' : 'On our schedule',
        progress: booking.status === 'booked' ? 40 : 25,
        message: booking.status === 'booked' ? 'Your booking is confirmed and on our schedule.' : 'Your trip is on our schedule.',
        etaLabel: null
      }
    };
  }

  return null;
}

async function activityPush(entry) {
  await db.run('INSERT INTO activity (id, initials, name, action, detail, time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    crypto.randomUUID(), entry.initials, entry.name, entry.action, entry.detail, entry.time, new Date().toISOString());
  realtime.broadcast('activity', { entry });
}

// Realtime announcement helpers. Every message is persisted first (the REST
// response is the durable source of truth) and then announced on the socket
// so the other two portals update instantly.
async function announceMessage(message) {
  if (!message) return;
  const audiences = ['staff'];
  if (message.operator_driver_id) audiences.push({ type: 'driver', id: message.operator_driver_id });
  if (message.recipient_driver_id) audiences.push({ type: 'driver', id: message.recipient_driver_id });
  if (message.customer_email) audiences.push({ type: 'customer', email: message.customer_email });
  realtime.broadcast('message.new', { message }, audiences);
}

async function announceJobChange(job) {
  if (!job) return;
  const audiences = ['staff'];
  if (job.operatorDriverId) audiences.push({ type: 'driver', id: job.operatorDriverId });
  if (job.bookingId) {
    const booking = await db.get('SELECT email FROM bookings WHERE id = ?', job.bookingId);
    if (booking && booking.email) audiences.push({ type: 'customer', email: booking.email });
  }
  if (job.driver) {
    const driver = (await getDrivers()).find((candidate) => candidate.name === job.driver);
    const linkedUser = driver ? await db.get('SELECT driver_id FROM users WHERE driver_id = ? LIMIT 1', driver.id) : null;
    const driverId = linkedUser?.driver_id || driver?.id || null;
    if (driverId) audiences.push({ type: 'driver', id: driverId });
  }
  realtime.broadcast('job.status', { job }, audiences);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
}

function rateLimit({ windowMs, max, name }) {
  pruneRateBuckets();
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    rateBuckets.set(key, bucket);
    next();
  };
}

function pruneRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function emailName(value) {
  return String(value || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Dispatcher';
}

function makeInitials(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'C';
  return parts.map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function generateLicenseKey() {
  return `RZ-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

function normalizeLicenseKey(value) {
  return String(value || '').trim().toUpperCase();
}

function validateLicenseKey(value) {
  return /^RZ-[A-F0-9]{32}$/.test(normalizeLicenseKey(value));
}

async function revokeLicense({ userId = null, customerEmail = null } = {}) {
  await db.run('DELETE FROM licenses WHERE (user_id = ? AND ?::text IS NOT NULL) OR (customer_email = ? AND ?::text IS NOT NULL)', userId, userId, customerEmail, customerEmail);
}

async function createLicenseRecord({ userId, customerEmail, stripeSessionId = null, source = 'manual', licenseKey = null } = {}) {
  const record = {
    id: `LIC-${crypto.randomUUID()}`,
    userId: userId || null,
    licenseKey: normalizeLicenseKey(licenseKey || generateLicenseKey()),
    type: 'lifetime',
    status: 'active',
    stripeSessionId: stripeSessionId || null,
    customerEmail: customerEmail || null,
    source,
    createdAt: new Date().toISOString()
  };

  await revokeLicense({ userId: record.userId, customerEmail: record.customerEmail });
  await db.run('INSERT INTO licenses (id, user_id, license_key, type, status, stripe_session_id, customer_email, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    record.id, record.userId, record.licenseKey, record.type, record.status, record.stripeSessionId, record.customerEmail, record.source, record.createdAt);
  return record;
}

async function findLicenseRecord(key, userId = null) {
  const normalized = normalizeLicenseKey(key);
  const row = await db.get('SELECT * FROM licenses WHERE license_key = ? AND status = ?', normalized, 'active');
  if (!row) return null;
  if (userId && row.user_id !== userId) return null;
  return { id: row.id, licenseKey: row.license_key, type: row.type, status: row.status, stripeSessionId: row.stripe_session_id, customerEmail: row.customer_email, source: row.source };
}

function getLicenseKeyFromRequest(req) {
  const header = req.headers['x-license-key'];
  const auth = req.headers.authorization;
  const fromBody = req.body && typeof req.body.licenseKey === 'string' ? req.body.licenseKey : '';
  const fromQuery = req.query && typeof req.query.licenseKey === 'string' ? req.query.licenseKey : '';
  const candidates = [header, validateLicenseKey(auth) ? auth : '', fromBody, fromQuery];
  return normalizeLicenseKey(candidates.find(Boolean) || '');
}

async function hasValidLicense(user, suppliedKey = '') {
  if (!REQUIRE_LICENSE && !suppliedKey && !user) return true;
  if (user) {
    const row = await db.get('SELECT * FROM licenses WHERE user_id = ? AND status = ?', user.id, 'active');
    if (row) return true;
  }
  const key = validateLicenseKey(suppliedKey) ? normalizeLicenseKey(suppliedKey) : normalizeLicenseKey(DEMO_LICENSE_KEY);
  if (!key) return false;
  if (DEMO_LICENSE_KEY && normalizeLicenseKey(DEMO_LICENSE_KEY) === key) return true;
  return Boolean(await findLicenseRecord(key, user ? user.id : null));
}

async function buildAccountSummary(user) {
  const license = await db.get('SELECT * FROM licenses WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1', user.id, 'active');
  const plan = 'Lifetime';
  const status = license ? 'Active' : 'Inactive';
  const memberSince = (await db.get('SELECT created_at FROM users WHERE id = ?', user.id))?.created_at || new Date().toISOString();
  const billingAmount = (LIFETIME_PRICE_CENTS / 100).toFixed(2);

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    workspace: 'West Coast Fleet',
    plan,
    licenseStatus: status,
    memberSince,
    seats: 1,
    billing: {
      type: plan,
      status,
      amount: `$${billingAmount}`,
      currency: LIFETIME_CURRENCY.toUpperCase(),
      cycle: 'One-time purchase'
    },
    lastUpdated: new Date().toISOString()
  };
}

async function getAdminOverview() {
  const totalUsers = Number((await db.get('SELECT COUNT(*) as count FROM users'))?.count || 0);
  const activeLicenses = Number((await db.get('SELECT COUNT(*) as count FROM licenses WHERE status = ?', 'active'))?.count || 0);
  const totalRevenue = Number(((activeLicenses * LIFETIME_PRICE_CENTS) / 100).toFixed(2));

  return {
    totalUsers,
    activeLicenses,
    totalRevenue,
    trialUsers: Math.max(0, totalUsers - activeLicenses),
    currency: LIFETIME_CURRENCY.toUpperCase(),
    uptime: '99.9%'
  };
}

async function buildBillingSummary() {
  const overview = await getAdminOverview();
  const recurring = 0;
  const price = (LIFETIME_PRICE_CENTS / 100).toFixed(2);
  return {
    plan: 'Lifetime',
    amount: `$${price}`,
    currency: LIFETIME_CURRENCY.toUpperCase(),
    monthlyRecurringRevenue: `$${recurring.toFixed(2)}`,
    annualRevenue: `$${overview.totalRevenue.toFixed(2)}`,
    activeCustomers: overview.activeLicenses,
    churnRate: '0.0%',
    nextInvoice: 'N/A',
    collectionStatus: 'Healthy'
  };
}

function createEmailVerificationToken(payload) {
  return jwt.sign({ userId: payload.id, email: payload.email, purpose: 'email_verification' }, JWT_SECRET, { expiresIn: '7d' });
}

function verificationLink(token) {
  return `${PUBLIC_URL}/api/auth/verify-email/${encodeURIComponent(token)}`;
}

function createPasswordResetToken(payload) {
  return jwt.sign({ userId: payload.id, email: payload.email, purpose: 'password_reset' }, JWT_SECRET, { expiresIn: '1h' });
}

function verifyPasswordResetToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.purpose !== 'password_reset') {
    throw new Error('Invalid purpose');
  }
  return { userId: decoded.userId, email: decoded.email };
}

function resetLink(token) {
  return `${PUBLIC_URL}/index.html?reset=${encodeURIComponent(token)}`;
}

function verifyEmailToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.purpose !== 'email_verification') {
    throw new Error('Invalid purpose');
  }
  return { userId: decoded.userId, email: decoded.email };
}

async function fulfillLifetimePurchase(session) {
  const userId = session.userId || session.metadata?.userId || null;
  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const existing = await db.get('SELECT * FROM licenses WHERE stripe_session_id = ?', session.id);
  if (existing) {
    if ((!existing.user_id && userId) || (!existing.customer_email && customerEmail)) {
      await db.run('UPDATE licenses SET user_id = COALESCE(?, user_id), customer_email = COALESCE(?, customer_email) WHERE id = ?', userId, customerEmail, existing.id);
    }
    return { licenseKey: existing.license_key, type: existing.type, status: existing.status };
  }
  return createLicenseRecord({
    userId,
    customerEmail,
    stripeSessionId: session.id,
    source: 'stripe'
  });
}

async function handleStripeWebhook(req, res) {
  if (!stripe || !stripeWebhookSecret) return res.status(503).send('Webhook is not configured');
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const isLifetimePurchase = session.metadata?.product === 'rz-dispatch' && session.metadata?.licenseType === 'lifetime';
    if (isLifetimePurchase && session.payment_status === 'paid') await fulfillLifetimePurchase(session);
  }
  res.json({ received: true });
}

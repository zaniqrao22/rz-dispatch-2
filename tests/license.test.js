const assert = require('node:assert/strict');
const test = require('node:test');
const {
  generateLicenseKey,
  validateLicenseKey,
  createLicenseRecord,
  revokeLicense,
  calculateQuoteEstimate,
  createQuoteRecord,
  createBookingRecord,
  lookupCustomerOrder,
  buildAccountSummary,
  getAdminOverview,
  buildBillingSummary,
  createEmailVerificationToken,
  verifyEmailToken,
  getJobs,
  buildCustomerDirectory,
  getServiceConfigurations,
  getZoneConfigurations,
  optimizeDispatchRoute,
  getVehicles
} = require('../server');

test('license system creates a valid key and active record', async () => {
  const key = generateLicenseKey();
  assert.match(key, /^RZ-[A-F0-9]{32}$/);
  const record = await createLicenseRecord({ customerEmail: 'buyer@example.com', stripeSessionId: 'demo_123' });
  assert.equal(record.customerEmail, 'buyer@example.com');
  assert.equal(record.status, 'active');
  assert.ok(validateLicenseKey(record.licenseKey));
});

test('saas layer exposes account summary and admin overview', async () => {
  const user = { id: 'saas-user-1', email: 'owner@example.com', role: 'owner' };
  await revokeLicense({ userId: user.id, customerEmail: user.email });
  const summary = await buildAccountSummary(user);
  assert.equal(summary.plan, 'Lifetime');
  assert.equal(summary.licenseStatus, 'Inactive');
  assert.equal(summary.billing.type, 'Lifetime');

  await createLicenseRecord({ userId: user.id, customerEmail: user.email, source: 'test' });
  const activeSummary = await buildAccountSummary(user);
  assert.equal(activeSummary.licenseStatus, 'Active');

  const overview = await getAdminOverview();
  assert.ok(typeof overview.totalUsers === 'number');
  assert.ok(typeof overview.activeLicenses === 'number');
  assert.ok(typeof overview.totalRevenue === 'number');
  assert.ok(overview.totalRevenue >= 0);
});

test('billing and email verification helpers work', async () => {
  const billing = await buildBillingSummary();
  assert.equal(billing.plan, 'Lifetime');
  assert.equal(billing.amount, '$499.00');

  const token = createEmailVerificationToken({ id: 'user-verify-1', email: 'verify@example.com' });
  assert.ok(token && token.length > 20);

  const verification = verifyEmailToken(token);
  assert.equal(verification.email, 'verify@example.com');
  assert.equal(verification.userId, 'user-verify-1');
});

test('jobs data loads without reserved-word SQL errors', async () => {
  const jobs = await getJobs();
  assert.ok(Array.isArray(jobs));
  assert.ok(jobs.length >= 1);
  assert.ok('from' in jobs[0]);
  assert.ok('to' in jobs[0]);
});

test('fleet roster loads seeded vehicles', async () => {
  const vehicles = await getVehicles();
  assert.ok(Array.isArray(vehicles));
  assert.ok(vehicles.length >= 1);
  vehicles.forEach((vehicle) => {
    assert.ok(vehicle.plate);
    assert.ok(vehicle.make);
    assert.ok(vehicle.model);
    assert.ok(vehicle.capacity >= 1);
    assert.ok(['available', 'on-route', 'off-duty', 'maintenance'].includes(vehicle.status));
  });
});

test('dispatch optimizer prioritizes urgent and shorter active loads', () => {
  const optimized = optimizeDispatchRoute([
    { id: 'JO-LONG', priority: 'Standard', distance: '12 mi', status: 'queued' },
    { id: 'JO-URGENT', priority: 'Urgent', distance: '20 mi', status: 'queued' },
    { id: 'JO-SHORT', priority: 'Standard', distance: '2 mi', status: 'assigned' },
    { id: 'JO-DONE', priority: 'Urgent', distance: '1 mi', status: 'completed' }
  ]);
  assert.deepEqual(optimized.map((job) => job.id), ['JO-URGENT', 'JO-SHORT', 'JO-LONG']);
  assert.deepEqual(optimized.map((job) => job.routeOrder), [1, 2, 3]);
});

test('crm directory aggregates customer contacts and history', async () => {
  const customers = await buildCustomerDirectory();
  assert.ok(Array.isArray(customers));
  customers.forEach((customer) => {
    assert.ok(customer.email);
    assert.ok(Array.isArray(customer.history));
    assert.equal(typeof customer.totalSpend, 'number');
  });
});

test('service configuration drives dynamic quote pricing', async () => {
  const services = await getServiceConfigurations();
  assert.ok(services.length >= 1);
  const sameDay = services.find((service) => service.key === 'same-day');
  assert.ok(sameDay);
  const estimate = await calculateQuoteEstimate({ serviceType: 'same-day', vehicleType: 'car', miles: 10, passengers: 1, hours: 1 });
  assert.equal(estimate.breakdown.base, sameDay.basePrice);
  assert.equal(estimate.breakdown.distanceRate, Number((sameDay.distanceRate * 10).toFixed(2)));
});

test('coverage configuration exposes active geofenced regions', async () => {
  const zones = await getZoneConfigurations();
  assert.ok(zones.length >= 5);
  zones.forEach((zone) => {
    assert.ok(zone.key);
    assert.ok(zone.boundary);
    assert.equal(typeof zone.active, 'boolean');
    assert.equal(typeof zone.baseSurcharge, 'number');
  });
});

test('dashboard configuration exposes dynamic service and zone data', async () => {
  const services = await getServiceConfigurations();
  const zones = await getZoneConfigurations();
  assert.ok(services.every((service) => service.key && service.name));
  assert.ok(zones.every((zone) => zone.key && zone.boundary));
});

test('booking and quote engine creates valid estimates and bookings', async () => {
  const estimate = await calculateQuoteEstimate({
    serviceType: 'same-day',
    vehicleType: 'van',
    miles: 24,
    passengers: 2,
    hours: 3
  });

  assert.ok(estimate.total > 0);
  assert.ok(estimate.breakdown.base > 0);
  assert.equal(estimate.status, 'ready');

  const quote = await createQuoteRecord({
    customerName: 'Alicia Reed',
    email: 'alicia@example.com',
    phone: '555-0102',
    serviceType: 'airport-transfer',
    pickupAddress: 'SFO Terminal 3',
    dropoffAddress: 'Downtown Hotel',
    serviceDate: '2026-09-20',
    vehicleType: 'car',
    miles: 18,
    passengers: 2,
    notes: 'Need early pickup'
  });

  const booking = await createBookingRecord({
    ...quote,
    status: 'booked',
    customerName: 'Alicia Reed',
    email: 'alicia@example.com',
    phone: '555-0102'
  });

  assert.ok(quote.id.startsWith('Q-'));
  assert.ok(booking.id.startsWith('BK-'));
  assert.equal(booking.status, 'booked');
  assert.ok(booking.quoteTotal >= 0);
});

test('customer portal lookup returns quote and booking details', async () => {
  const quote = await createQuoteRecord({
    customerName: 'Jordan Bell',
    email: 'jordan@example.com',
    phone: '555-0199',
    serviceType: 'airport-transfer',
    pickupAddress: 'Downtown Office',
    dropoffAddress: 'SFO Terminal 4',
    serviceDate: '2026-09-25',
    vehicleType: 'suv',
    miles: 16,
    passengers: 3,
    hours: 2,
    notes: 'Late flight',
    quoteTotal: 144.92,
    status: 'pending'
  });

  const found = await lookupCustomerOrder({ orderId: quote.id, email: 'jordan@example.com' });
  assert.ok(found);
  assert.equal(found.kind, 'quote');
  assert.equal(found.email, 'jordan@example.com');
  assert.ok(found.status === 'pending' || found.status === 'accepted');
});

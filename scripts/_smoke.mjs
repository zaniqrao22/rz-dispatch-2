import EmbeddedPostgres from 'embedded-postgres';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.SMOKE_PG_PORT) || 55432;
const database = 'rz_dispatch';
// Dedicated data dir so the smoke run never touches the persistent .pgdata.
const dbDir = path.join(__dirname, '..', '.pgdata-smoke');

const pg = new EmbeddedPostgres({
  databaseDir: dbDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: false,
  authMethod: 'password'
});

try {
  console.log('Initialising cluster...');
  await pg.initialise();
  console.log('Starting embedded PostgreSQL on port', port);
  await pg.start();
  await pg.createDatabase(database);

  process.env.PGHOST = '127.0.0.1';
  process.env.PGPORT = String(port);
  process.env.PGDATABASE = database;
  process.env.PGUSER = 'postgres';
  process.env.PGPASSWORD = 'postgres';
  process.env.REQUIRE_LICENSE = 'false';

  const {
    initializeDatabase,
    getJobs,
    getServiceConfigurations,
    getZoneConfigurations,
    calculateQuoteEstimate,
    createQuoteRecord,
    createBookingRecord,
    buildCustomerDirectory,
    getAdminOverview,
    findLicenseRecord,
    createLicenseRecord,
    lookupCustomerOrder,
    getActivity
  } = await import('../server.js');

  await initializeDatabase();

  const jobs = await getJobs();
  console.log('jobs:', jobs.length, 'first:', JSON.stringify({ id: jobs[0]?.id, from: jobs[0]?.from, to: jobs[0]?.to }));

  const services = await getServiceConfigurations();
  console.log('services:', services.length, 'sameDay base:', services.find((s) => s.key === 'same-day')?.basePrice);

  const zones = await getZoneConfigurations();
  console.log('zones:', zones.length, 'firstActiveType:', typeof zones[0]?.active);

  const estimate = await calculateQuoteEstimate({ serviceType: 'same-day', vehicleType: 'car', miles: 10, passengers: 1, hours: 1 });
  console.log('estimate.total:', estimate.total, 'base:', estimate.breakdown.base);

  const quote = await createQuoteRecord({
    customerName: 'Smoke Tester',
    email: 'smoke@example.com',
    phone: '555-0000',
    serviceType: 'airport-transfer',
    pickupAddress: 'A St',
    dropoffAddress: 'B St',
    serviceDate: '2026-10-01',
    vehicleType: 'car',
    miles: 5,
    passengers: 1,
    hours: 1,
    quoteTotal: 100,
    status: 'pending'
  });
  const booking = await createBookingRecord({ ...quote, status: 'booked', quoteTotal: 100 });
  console.log('quote.id:', quote.id, 'booking.id:', booking.id);

  const customers = await buildCustomerDirectory();
  console.log('customers:', customers.length, 'historyLen:', customers[0]?.history?.length);

  const found = await lookupCustomerOrder({ orderId: quote.id, email: 'smoke@example.com' });
  console.log('lookup.kind:', found?.kind, 'status:', found?.status);

  const license = await createLicenseRecord({ customerEmail: 'smoke@example.com', stripeSessionId: 'smoke_session' });
  const byKey = await findLicenseRecord(license.licenseKey, null);
  console.log('license.key:', license.licenseKey.slice(0, 8), 'findByKey:', Boolean(byKey && byKey.licenseKey === license.licenseKey));

  const overview = await getAdminOverview();
  console.log('overview:', JSON.stringify(overview));

  const activity = await getActivity();
  console.log('activity rows:', activity.length);

  console.log('SMOKE_OK');
} catch (error) {
  console.error('SMOKE_FAIL:', error.message);
  process.exitCode = 1;
} finally {
  try {
    await pg.stop();
  } catch (_) {
    // Already stopped.
  }
}
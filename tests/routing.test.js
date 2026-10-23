const assert = require('node:assert/strict');
const test = require('node:test');

const { createRouting, haversineMiles } = require('../backend/routing');

// San Francisco -> Oakland is ~10 miles straight-line; driving is ~13-14.
const FROM = '1280 Market Street, San Francisco';
const TO = '77 Geary Street, San Francisco';

function fakeGeocoder(fetchImpl) {
  // Nominatim-style response; two distinct coordinates.
  return async (url, options) => {
    if (String(url).includes('nominatim')) {
      const isFrom = decodeURIComponent(String(url)).includes('Market');
      const body = isFrom
        ? [{ lat: '37.7749', lon: '-122.4194' }]
        : [{ lat: '37.7889', lon: '-122.4069' }];
      return { ok: true, json: async () => body };
    }
    return fetchImpl(url, options);
  };
}

test('falls back to a haversine estimate when no provider is configured', async () => {
  const routing = createRouting({
    provider: '',
    fetchImpl: fakeGeocoder(async () => {
      throw new Error('provider should not be called without a key');
    })
  });
  const result = await routing.distanceMiles(FROM, TO);
  assert.equal(result.source, 'estimate');
  assert.ok(result.miles > 0);
  const straight = haversineMiles(37.7749, -122.4194, 37.7889, -122.4069);
  assert.ok(Math.abs(result.miles - Math.round(straight * 1.25)) <= 1);
});

test('OpenRouteService distances are converted from meters to miles', async () => {
  const routing = createRouting({
    provider: 'openrouteservice',
    apiKey: 'test-key',
    fetchImpl: fakeGeocoder(async (url, options) => {
      assert.match(String(url), /openrouteservice\.org/);
      assert.equal(options.headers.Authorization, 'test-key');
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.coordinates, [[-122.4194, 37.7749], [-122.4069, 37.7889]]);
      return { ok: true, json: async () => ({ routes: [{ summary: { distance: 16093.44 } }] }) };
    })
  });
  const result = await routing.distanceMiles(FROM, TO);
  assert.equal(result.source, 'provider');
  assert.equal(result.miles, 10);
});

test('Mapbox distances are converted from meters to miles', async () => {
  const routing = createRouting({
    provider: 'mapbox',
    apiKey: 'pk.test',
    fetchImpl: fakeGeocoder(async (url) => {
      assert.match(String(url), /api\.mapbox\.com\/directions\/v5/);
      assert.match(String(url), /access_token=pk\.test/);
      return { ok: true, json: async () => ({ routes: [{ distance: 24140.16 }] }) };
    })
  });
  const result = await routing.distanceMiles(FROM, TO);
  assert.equal(result.source, 'provider');
  assert.equal(result.miles, 15);
});

test('OSRM works without an API key', async () => {
  const routing = createRouting({
    provider: 'osrm',
    fetchImpl: fakeGeocoder(async (url) => {
      assert.match(String(url), /router\.project-osrm\.org\/route\/v1\/driving/);
      return { ok: true, json: async () => ({ routes: [{ distance: 20116.8 }] }) };
    })
  });
  assert.equal(routing.enabled, true);
  const result = await routing.distanceMiles(FROM, TO);
  assert.equal(result.source, 'provider');
  assert.equal(result.miles, 13);
});

test('a failing provider silently degrades to the estimate', async () => {
  const routing = createRouting({
    provider: 'openrouteservice',
    apiKey: 'test-key',
    fetchImpl: fakeGeocoder(async () => {
      throw new Error('network down');
    })
  });
  const result = await routing.distanceMiles(FROM, TO);
  assert.equal(result.source, 'estimate');
  assert.ok(result.miles > 0);
});

test('an ungeocodable address reports unavailable instead of a bogus mileage', async () => {
  const routing = createRouting({
    provider: '',
    fetchImpl: async () => ({ ok: true, json: async () => [] })
  });
  const result = await routing.distanceMiles('nowhere', 'elsewhere');
  assert.equal(result.miles, null);
  assert.equal(result.source, 'unavailable');
});

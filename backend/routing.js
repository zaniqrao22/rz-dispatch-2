'use strict';

/**
 * Routing provider for quote distance lookups.
 *
 * The original implementation only did a haversine great-circle distance with a
 * flat 1.25 "road factor", which is a rough proxy for driving distance. This
 * module keeps that as a **fallback** but first tries a real routing engine so
 * quotes reflect actual road miles:
 *
 *   - OpenRouteService  (ROUTING_PROVIDER=openrouteservice, ROUTING_API_KEY=...)
 *   - Mapbox Directions (ROUTING_PROVIDER=mapbox, ROUTING_API_KEY=...)
 *   - OSRM              (ROUTING_PROVIDER=osrm, ROUTING_BASE_URL optional)
 *
 * Every provider call is best-effort: a missing key, a timeout, a bad response
 * or a geocoding failure all degrade to the haversine estimate instead of
 * failing the quote. The returned `source` tells the caller which path ran.
 */

const METERS_PER_MILE = 1609.344;
const GEOCODE_TIMEOUT_MS = 8000;
const ROUTE_TIMEOUT_MS = 8000;
const ROAD_FACTOR = 1.25;

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function createRouting(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : global.fetch;
  const provider = String(options.provider || process.env.ROUTING_PROVIDER || '').trim().toLowerCase();
  const apiKey = String(options.apiKey || process.env.ROUTING_API_KEY || '').trim();
  const baseUrl = String(options.baseUrl || process.env.ROUTING_BASE_URL || '').trim();
  const userAgent = options.userAgent || 'RZDispatch/2.0 (routing; support@rzdispatch.local)';
  const geocodeUrl = options.geocodeUrl || 'https://nominatim.openstreetmap.org/search';

  const enabled = Boolean(provider && provider !== 'none' && (provider === 'osrm' || apiKey));

  async function geocode(address) {
    try {
      const url = `${geocodeUrl}?format=json&limit=1&q=${encodeURIComponent(address)}`;
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        { headers: { 'User-Agent': userAgent, Accept: 'application/json' } },
        GEOCODE_TIMEOUT_MS
      );
      if (!response.ok) return null;
      const results = await response.json();
      const first = Array.isArray(results) && results[0];
      if (!first) return null;
      const lat = Number(first.lat);
      const lon = Number(first.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch (_) {
      return null;
    }
  }

  async function providerDistanceMiles(from, to) {
    if (provider === 'openrouteservice') {
      const response = await fetchWithTimeout(
        fetchImpl,
        baseUrl || 'https://api.openrouteservice.org/v2/directions/driving-car',
        {
          method: 'POST',
          headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]] })
        },
        ROUTE_TIMEOUT_MS
      );
      if (!response.ok) return null;
      const body = await response.json();
      const meters = body?.routes?.[0]?.summary?.distance;
      return Number.isFinite(meters) ? meters / METERS_PER_MILE : null;
    }

    if (provider === 'mapbox') {
      const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${encodeURIComponent(apiKey)}&overview=false`;
      const response = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, ROUTE_TIMEOUT_MS);
      if (!response.ok) return null;
      const body = await response.json();
      const meters = body?.routes?.[0]?.distance;
      return Number.isFinite(meters) ? meters / METERS_PER_MILE : null;
    }

    if (provider === 'osrm') {
      const base = (baseUrl || 'https://router.project-osrm.org').replace(/\/+$/, '');
      const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
      const response = await fetchWithTimeout(
        fetchImpl,
        `${base}/route/v1/driving/${coords}?overview=false`,
        { headers: { Accept: 'application/json' } },
        ROUTE_TIMEOUT_MS
      );
      if (!response.ok) return null;
      const body = await response.json();
      const meters = body?.routes?.[0]?.distance;
      return Number.isFinite(meters) ? meters / METERS_PER_MILE : null;
    }

    return null;
  }

  /**
   * Resolve driving miles between two free-text addresses.
   * Returns { miles, source, provider } — never null. When addresses cannot be
   * geocoded at all, `miles` is null and `source` is 'unavailable'.
   */
  async function distanceMiles(fromAddress, toAddress) {
    const from = await geocode(fromAddress);
    if (!from) return { miles: null, source: 'unavailable', provider: provider || 'none' };
    const to = await geocode(toAddress);
    if (!to) return { miles: null, source: 'unavailable', provider: provider || 'none' };

    if (enabled) {
      try {
        const routed = await providerDistanceMiles(from, to);
        if (Number.isFinite(routed) && routed > 0) {
          return { miles: Math.max(1, Math.round(routed)), source: 'provider', provider };
        }
      } catch (_) {
        // fall through to the estimate
      }
    }

    const estimate = haversineMiles(from.lat, from.lon, to.lat, to.lon) * ROAD_FACTOR;
    return { miles: Math.max(1, Math.round(estimate)), source: 'estimate', provider: provider || 'none' };
  }

  return {
    provider: provider || 'none',
    enabled,
    geocode,
    distanceMiles,
    haversineMiles
  };
}

const routing = createRouting();

module.exports = { createRouting, routing, haversineMiles, METERS_PER_MILE };

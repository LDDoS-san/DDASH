/* wbgt_risk_tuned.js
 * B案：JS単体で C を環境省WBGT（京都）に自動チューニングしてキャッシュする版
 *
 * できること：
 *  - initTuningKyoto({day, gridKm}) で C_best を自動推定（初回だけ重い）
 *  - getRiskAt({lat, lon, day, hour, ...}) で tuned C による WBGT + リスクを返す
 *
 * 動作環境：
 *  - Browser: window.WBGTRiskTuned
 *  - Node.js 18+: require("./wbgt_risk_tuned.js")（fetchが必要）
 *
 * 注意：
 *  - Open-Meteo archive は「過去」のみ。未来/今日の予報は別APIに切替が必要。
 */

(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.WBGTRiskTuned = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    timezone: "Asia/Tokyo",
    day: "2025-08-01",
    kyotoPrefCode: "26",
    kyotoGeoJsonUrl:
      "https://raw.githubusercontent.com/amay077/JapanPrefGeoJson/master/prefs/26.geojson",
    openMeteoEndpoint: "https://archive-api.open-meteo.com/v1/archive",
    hourlyVars:
      "temperature_2m,relative_humidity_2m,windspeed_10m,shortwave_radiation",
    gridKm: 5,
    batchSize: 80,
    baseDelaySec: 1.2,
    maxRetries: 8,
    Cmin: 0.5,
    Cmax: 6.0,
    Cstep: 0.1,
    C_fallback: 2.0,
    cachePrefix: "WBGT_CBEST_KYOTO_V1",
  };

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }
  function round1(x) {
    return Math.round(x * 10) / 10;
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function hasLocalStorage() {
    try {
      return typeof localStorage !== "undefined";
    } catch {
      return false;
    }
  }
  const memCache = new Map();

  function cacheKey(day, gridKm, timezone) {
    return `${DEFAULTS.cachePrefix}:${day}:${gridKm}:${timezone}`;
  }
  function getCachedC(day, gridKm, timezone) {
    const k = cacheKey(day, gridKm, timezone);
    if (hasLocalStorage()) {
      const s = localStorage.getItem(k);
      if (!s) return null;
      try {
        const obj = JSON.parse(s);
        if (obj && Number.isFinite(obj.C_best)) return obj;
      } catch {}
      return null;
    }
    return memCache.get(k) || null;
  }
  function setCachedC(day, gridKm, timezone, obj) {
    const k = cacheKey(day, gridKm, timezone);
    const payload = JSON.stringify(obj);
    if (hasLocalStorage()) {
      localStorage.setItem(k, payload);
    } else {
      memCache.set(k, obj);
    }
  }

  function pickLocationPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object") {
      if (Array.isArray(payload.locations)) return payload.locations;
      if (Array.isArray(payload.results)) return payload.results;
      return [payload];
    }
    throw new Error("Invalid Open-Meteo payload shape");
  }

  async function fetchWithRetry(url, opts = {}, cfg = DEFAULTS) {
    const maxRetries = cfg.maxRetries;
    const baseDelay = cfg.baseDelaySec * 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, opts);
      if (res.ok) return res;

      const code = res.status;
      if (code === 429 || (code >= 500 && code < 600)) {
        const jitter = Math.random() * 700;
        const backoff = Math.min(60000, baseDelay * Math.pow(1.6, attempt - 1) + jitter);
        await sleep(backoff);
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${code}: ${text.slice(0, 200)}`);
    }
    throw new Error("Failed after retries");
  }

  // Geo helpers (WebMercator + point-in-polygon)
  const R = 6378137;
  function lonLatToMercator(lon, lat) {
    const x = (lon * Math.PI / 180) * R;
    const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
    return [x, y];
  }
  function mercatorToLonLat(x, y) {
    const lon = (x / R) * 180 / Math.PI;
    const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
    return [lon, lat];
  }
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect =
        ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function geoContains(geom, lon, lat) {
    if (!geom) return false;
    const type = geom.type;
    if (type === "Polygon") {
      const rings = geom.coordinates;
      if (!rings || rings.length === 0) return false;
      if (!pointInRing(lon, lat, rings[0])) return false;
      for (let k = 1; k < rings.length; k++) {
        if (pointInRing(lon, lat, rings[k])) return false;
      }
      return true;
    }
    if (type === "MultiPolygon") {
      for (const poly of geom.coordinates || []) {
        if (!poly || poly.length === 0) continue;
        if (!pointInRing(lon, lat, poly[0])) continue;
        let inHole = false;
        for (let k = 1; k < poly.length; k++) {
          if (pointInRing(lon, lat, poly[k])) { inHole = true; break; }
        }
        if (!inHole) return true;
      }
      return false;
    }
    return false;
  }
  function bboxFromGeo(geom) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    function scanCoords(coords) {
      if (!coords) return;
      if (typeof coords[0] === "number") {
        const lon = coords[0], lat = coords[1];
        minx = Math.min(minx, lon); maxx = Math.max(maxx, lon);
        miny = Math.min(miny, lat); maxy = Math.max(maxy, lat);
      } else {
        for (const c of coords) scanCoords(c);
      }
    }
    scanCoords(geom.coordinates);
    return [minx, miny, maxx, maxy];
  }
  async function loadKyotoGeometry(cfg) {
    const res = await fetchWithRetry(cfg.kyotoGeoJsonUrl, {}, cfg);
    const gj = await res.json();
    let geom = null;
    if (gj && gj.type === "FeatureCollection" && Array.isArray(gj.features) && gj.features[0]) {
      geom = gj.features[0].geometry;
    } else if (gj && gj.type === "Feature" && gj.geometry) {
      geom = gj.geometry;
    } else if (gj && gj.type && gj.coordinates) {
      geom = gj;
    }
    if (!geom) throw new Error("Failed to parse Kyoto geometry");
    return geom;
  }
  function generateKyotoPoints(geom, gridKm) {
    const [minx, miny, maxx, maxy] = bboxFromGeo(geom);
    const [minx_m, miny_m] = lonLatToMercator(minx, miny);
    const [maxx_m, maxy_m] = lonLatToMercator(maxx, maxy);
    const step = gridKm * 1000;
    const pts = [];
    for (let x = minx_m; x <= maxx_m; x += step) {
      for (let y = miny_m; y <= maxy_m; y += step) {
        const [lon, lat] = mercatorToLonLat(x + step / 2, y + step / 2);
        if (geoContains(geom, lon, lat)) pts.push([lat, lon]);
      }
    }
    return pts;
  }

  // WBGT math
  function wetBulbStull(T, RH) {
    RH = clamp(RH, 1e-6, 100.0);
    const a = T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659));
    const b = Math.atan(T + RH);
    const c = Math.atan(RH - 1.676331);
    const d = 0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH);
    return a + b - c + d - 4.686035;
  }
  function wbgtOutdoorFromC(Ta, Tw, SR, WS, C) {
    SR = Math.max(0, SR);
    WS = Math.max(0, WS);
    const Tg = Ta + C * (Math.sqrt(SR) / Math.sqrt(Math.max(WS + 0.5, 0.5)));
    return 0.7 * Tw + 0.2 * Tg + 0.1 * Ta;
  }

  // Env Kyoto CSV -> hourly max (Kyoto max across sites)
  function envCsvUrlKyoto(day) {
    const yyyymm = day.replaceAll("-", "").slice(0, 6);
    return `https://www.wbgt.env.go.jp/est15WG/dl/wbgt_kyoto_${yyyymm}.csv`;
  }
  function parseEnvKyotoHourlyMax(csvText, day) {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw new Error("Env CSV empty");
    const header = lines[0].split(",");
    const dateIdx = header.indexOf("Date");
    const timeIdx = header.indexOf("Time");
    if (dateIdx < 0 || timeIdx < 0) throw new Error("Env CSV missing Date/Time");
    const siteIdx = header
      .map((h, i) => ({ h, i }))
      .filter((x) => x.h !== "Date" && x.h !== "Time" && x.h !== "datetime")
      .map((x) => x.i);

    const env15 = new Map();
    for (let li = 1; li < lines.length; li++) {
      const cols = lines[li].split(",");
      if (cols.length < header.length) continue;
      const d = (cols[dateIdx] || "").trim();
      const t = (cols[timeIdx] || "").trim();
      let dNorm = d;
      if (/^\d{8}$/.test(d)) dNorm = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      else if (/^\d{4}\/\d{2}\/\d{2}$/.test(d)) dNorm = d.replaceAll("/", "-");
      if (dNorm !== day) continue;

      const m = t.match(/^(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const hh = String(parseInt(m[1], 10)).padStart(2, "0");
      const mm = m[2];
      const key15 = `${day}T${hh}:${mm}`;

      let mx = -Infinity;
      for (const idx of siteIdx) {
        const v = parseFloat(cols[idx]);
        if (Number.isFinite(v)) mx = Math.max(mx, v);
      }
      if (!Number.isFinite(mx)) continue;
      env15.set(key15, mx);
    }

    const envHour = new Map();
    for (const [k15, v] of env15.entries()) {
      const hh = k15.slice(11, 13);
      const kH = `${day}T${hh}:00`;
      const prev = envHour.get(kH);
      envHour.set(kH, prev == null ? v : Math.max(prev, v));
    }
    return envHour;
  }

  // Open-Meteo multi-location
  async function fetchOpenMeteoForPoints(pointsLatLon, day, cfg) {
    const outRows = [];
    const batchSize = cfg.batchSize;

    for (let i = 0; i < pointsLatLon.length; i += batchSize) {
      const batch = pointsLatLon.slice(i, i + batchSize);
      const lats = batch.map((p) => p[0].toFixed(5)).join(",");
      const lons = batch.map((p) => p[1].toFixed(5)).join(",");

      const url = new URL(cfg.openMeteoEndpoint);
      url.searchParams.set("latitude", lats);
      url.searchParams.set("longitude", lons);
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("hourly", cfg.hourlyVars);
      url.searchParams.set("timezone", cfg.timezone);

      const res = await fetchWithRetry(url.toString(), {}, cfg);
      const payload = await res.json();
      const locs = pickLocationPayload(payload);

      for (const loc of locs) {
        if (!loc || !loc.hourly) continue;
        const lat = Number(loc.latitude);
        const lon = Number(loc.longitude);
        const h = loc.hourly;

        const times = h.time || [];
        const temp = h.temperature_2m || [];
        const rh = h.relative_humidity_2m || [];
        const ws = h.windspeed_10m || [];
        const sr = h.shortwave_radiation || [];
        const n = times.length;

        if (!n || temp.length !== n || rh.length !== n || ws.length !== n || sr.length !== n) continue;

        for (let t = 0; t < n; t++) {
          const timeKey = `${String(times[t]).slice(0, 13)}:00`;
          outRows.push({
            timeKey,
            lat, lon,
            temp: Number(temp[t]),
            rh: Number(rh[t]),
            ws: Number(ws[t]),
            sr: Number(sr[t]),
          });
        }
      }

      await sleep(cfg.baseDelaySec * 1000);
    }

    return outRows;
  }

  // Tune C
  function tuneCFromRows(rows, envHourMap, cfg) {
    const timesInRows = new Set(rows.map((r) => r.timeKey));
    const commonTimes = [];
    for (const k of envHourMap.keys()) if (timesInRows.has(k)) commonTimes.push(k);
    commonTimes.sort();
    if (commonTimes.length < 6) throw new Error(`Too few common hours: ${commonTimes.length}`);

    const byTime = new Map();
    for (const r of rows) {
      if (!byTime.has(r.timeKey)) byTime.set(r.timeKey, []);
      byTime.get(r.timeKey).push(r);
    }

    const Cs = [];
    for (let c = cfg.Cmin; c <= cfg.Cmax + 1e-9; c += cfg.Cstep) Cs.push(Math.round(c * 100) / 100);

    let best = null;
    for (const C of Cs) {
      let absSum = 0, sqSum = 0, cnt = 0;
      for (const tk of commonTimes) {
        const env = envHourMap.get(tk);
        if (!Number.isFinite(env)) continue;
        const arr = byTime.get(tk) || [];
        let mx = -Infinity;
        for (const r of arr) {
          if (![r.temp, r.rh, r.ws, r.sr].every(Number.isFinite)) continue;
          const Tw = wetBulbStull(r.temp, r.rh);
          const wbgt = wbgtOutdoorFromC(r.temp, Tw, r.sr, r.ws, C);
          if (Number.isFinite(wbgt)) mx = Math.max(mx, wbgt);
        }
        if (!Number.isFinite(mx)) continue;
        const diff = mx - env;
        absSum += Math.abs(diff);
        sqSum += diff * diff;
        cnt += 1;
      }
      if (cnt < 6) continue;
      const mae = absSum / cnt;
      const rmse = Math.sqrt(sqSum / cnt);
      const cand = { mae, rmse, C, n: cnt };
      if (!best) best = cand;
      else if (cand.mae < best.mae - 1e-12) best = cand;
      else if (Math.abs(cand.mae - best.mae) <= 1e-12 && cand.rmse < best.rmse - 1e-12) best = cand;
      else if (Math.abs(cand.mae - best.mae) <= 1e-12 && Math.abs(cand.rmse - best.rmse) <= 1e-12 && cand.C < best.C) best = cand;
    }
    if (!best) throw new Error("Tuning failed (no valid candidate)");
    return best;
  }

  async function initTuningKyoto(opt = {}) {
    const cfg = { ...DEFAULTS, ...opt };
    const day = cfg.day;
    const gridKm = cfg.gridKm;
    const tz = cfg.timezone;

    const cached = getCachedC(day, gridKm, tz);
    if (cached) return cached;

    const geom = await loadKyotoGeometry(cfg);
    const pts = generateKyotoPoints(geom, gridKm);
    if (!pts.length) throw new Error("No points generated for Kyoto");

    const envRes = await fetchWithRetry(envCsvUrlKyoto(day), {}, cfg);
    const envText = await envRes.text();
    const envHour = parseEnvKyotoHourlyMax(envText, day);

    const rows = await fetchOpenMeteoForPoints(pts, day, cfg);
    const best = tuneCFromRows(rows, envHour, cfg);

    const result = {
      C_best: best.C,
      mae: best.mae,
      rmse: best.rmse,
      n_hours: best.n,
      day,
      gridKm,
      timezone: tz,
      created_at: new Date().toISOString(),
      note: "Kyoto tuned to Env Ministry WBGT (hourly max, Kyoto max).",
    };

    setCachedC(day, gridKm, tz, result);
    return result;
  }

  async function fetchOpenMeteoSingle(lat, lon, day, cfg) {
    const url = new URL(cfg.openMeteoEndpoint);
    url.searchParams.set("latitude", Number(lat).toFixed(5));
    url.searchParams.set("longitude", Number(lon).toFixed(5));
    url.searchParams.set("start_date", day);
    url.searchParams.set("end_date", day);
    url.searchParams.set("hourly", cfg.hourlyVars);
    url.searchParams.set("timezone", cfg.timezone);

    const res = await fetchWithRetry(url.toString(), {}, cfg);
    const payload = await res.json();
    const locs = pickLocationPayload(payload);
    const loc = locs[0];
    if (!loc || !loc.hourly) throw new Error("Missing hourly in Open-Meteo single");
    return { snapped_lat: loc.latitude, snapped_lon: loc.longitude, hourly: loc.hourly };
  }

  function hourKey(day, hour) {
    const hh = String(hour).padStart(2, "0");
    return `${day}T${hh}:00`;
  }
  function findIndexByHour(times, key) {
    const exact = `${key.slice(0, 13)}:00`;
    const idx = times.indexOf(exact);
    if (idx >= 0) return idx;
    const pref = key.slice(0, 13);
    for (let i = 0; i < times.length; i++) if ((times[i] || "").startsWith(pref)) return i;
    return -1;
  }
  function wbgtShade(Ta, Tw) {
    return 0.7 * Tw + 0.3 * Ta;
  }

  function riskScoreFromWBGT(wbgt, age, met, waterMlLast2h) {
    const x = clamp((wbgt - 22.0) / 12.0, 0.0, 1.0);
    const base = 10.0 + 75.0 * x;
    const ageAdd = age >= 65 ? 10.0 : (age < 15 ? 5.0 : 0.0);
    const metC = clamp(Number(met), 1.0, 10.0);
    const activityAdd = ((metC - 1.0) / 9.0) * 20.0;
    const ml = Math.max(0, Number(waterMlLast2h));
    const hydrationAdd = 18.0 * (1.0 - Math.min(1.0, ml / 600.0));
    const score = clamp(base + ageAdd + activityAdd + hydrationAdd, 0.0, 100.0);
    const s = round1(score);

    let level = "低";
    if (s <= 24) level = "低";
    else if (s <= 49) level = "注意";
    else if (s <= 74) level = "警戒";
    else level = "危険";

    return {
      score: s,
      level,
      breakdown: {
        base: round1(base),
        ageAdd: round1(ageAdd),
        activityAdd: round1(activityAdd),
        hydrationAdd: round1(hydrationAdd),
      },
    };
  }

  function recommendAction(level) {
    return {
      "低": "通常注意：こまめに水分補給。",
      "注意": "日陰・屋内を優先、30〜60分ごと休憩。",
      "警戒": "外出/運動は時間をずらす（朝夕へ）。",
      "危険": "今は避ける：屋内へ移動し活動は中止。",
    }[level] || "";
  }

  async function getRiskAt(params = {}) {
    const cfg = { ...DEFAULTS, ...(params.options || {}) };

    const lat = params.lat;
    const lon = params.lon;
    const day = params.day || cfg.day;
    const hour = Number(params.hour);
    const mode = params.mode || "outdoor";
    const age = Number(params.age ?? 30);
    const met = Number(params.met ?? 4.0);
    const water = Number(params.water_ml_last2h ?? 0);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("lat/lon must be numbers");
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) throw new Error("hour must be 0..23");

    let tuned = getCachedC(day, cfg.gridKm, cfg.timezone);
    if (!tuned) {
      try {
        tuned = await initTuningKyoto({ ...cfg, day });
      } catch (e) {
        tuned = {
          C_best: cfg.C_fallback,
          mae: null,
          rmse: null,
          n_hours: null,
          day,
          gridKm: cfg.gridKm,
          timezone: cfg.timezone,
          created_at: new Date().toISOString(),
          note: "Fallback C (tuning failed)",
          error: String(e && e.message ? e.message : e),
        };
      }
    }

    const loc = await fetchOpenMeteoSingle(lat, lon, day, cfg);
    const h = loc.hourly;
    const idx = findIndexByHour(h.time || [], hourKey(day, hour));
    if (idx < 0) throw new Error("Requested hour not found in Open-Meteo hourly.time");

    const Ta = Number(h.temperature_2m[idx]);
    const RH = Number(h.relative_humidity_2m[idx]);
    const WS = Number(h.windspeed_10m[idx]);
    const SR = Number(h.shortwave_radiation[idx]);

    const Tw = wetBulbStull(Ta, RH);
    const wbgt = (mode === "shade")
      ? wbgtShade(Ta, Tw)
      : wbgtOutdoorFromC(Ta, Tw, SR, WS, tuned.C_best);

    const risk = riskScoreFromWBGT(wbgt, age, met, water);

    return {
      input: { lat: Number(lat), lon: Number(lon), day, hour, mode, age, met, water_ml_last2h: water },
      snapped: { lat: loc.snapped_lat, lon: loc.snapped_lon },
      time: (h.time && h.time[idx]) ? h.time[idx] : hourKey(day, hour),
      wbgt: round1(wbgt),
      wbgt_raw: wbgt,
      meteo: { Ta, RH, WS, SR, Tw },
      tuned,
      risk,
      action: recommendAction(risk.level),
    };
  }

  return {
    DEFAULTS,
    initTuningKyoto,
    getRiskAt,
    wetBulbStull,
    wbgtOutdoorFromC,
    riskScoreFromWBGT,
    recommendAction,
  };
});

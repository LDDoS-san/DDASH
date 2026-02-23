// hospital.js
const COL_NAME = 1;
const COL_LAT  = 9;
const COL_LON  = 10;

const BASE_SECONDS = 30;
const SPEED_KMH = 40;

let hospitals = [];

function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadHospitalsFromCSV(url = '01-1_hospital_facility_info_20251201_kyoto.csv') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSV fetch failed: HTTP ${res.status}`);
  const text = await res.text();

  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const list = [];

  for (const line of lines) {
    const cols = parseCSVLine(line);
    const lat = parseFloat(cols[COL_LAT]);
    const lon = parseFloat(cols[COL_LON]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = (cols[COL_NAME] ?? '').trim();
    list.push({ name, lat, lon });
  }
  hospitals = list;
  return hospitals.length;
}

function distanceKmApprox(lat1, lon1, lat2, lon2) {
  const dLat = lat1 - lat2;
  const dLon = lon1 - lon2;
  const lat_km = dLat * 111.0;
  const meanLatRad = ((lat1 + lat2) / 2) * Math.PI / 180;
  const lon_km = dLon * 111.0 * Math.cos(meanLatRad);
  return Math.hypot(lat_km, lon_km);
}

function estimateTimeToNearestHospital(lat, lon) {
  if (!hospitals || hospitals.length === 0) {
    throw new Error('Hospitals not loaded yet. Call loadHospitalsFromCSV() first.');
  }

  let best = null;
  let minKm = Infinity;

  for (const h of hospitals) {
    const km = distanceKmApprox(lat, lon, h.lat, h.lon);
    if (km < minKm) { minKm = km; best = h; }
  }

  const seconds = BASE_SECONDS + (minKm / SPEED_KMH) * 3600;
  return { seconds, minutes: seconds/60, distance_km: minKm, hospital: best };
}

// グローバルに公開（別HTMLから呼べるようにする）
window.HospitalLib = {
  loadHospitalsFromCSV,
  estimateTimeToNearestHospital
};
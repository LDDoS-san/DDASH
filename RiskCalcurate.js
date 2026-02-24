/**
 * kyoto_wbgt_risk_ui.js
 * ============================================================
 * Kyoto WBGT (Open-Meteo temp/rh/wind/solar) + Env-WBGT tuning + UI (Browser JS)
 *  - A対応: 取得後に Open-Meteo が返した「ユニーク lat/lon（スナップ後）」をUI地点に採用
 *  - Fix: hourly["time"] を strict format でパース（silent dropしない）
 *  - Risk Score: WBGT→base を連続化 + 小数(0.1)表示
 *
 * 依存（CDN例）:
 *  <script src="https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.min.js"></script>
 *  <script src="https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/turf.min.js"></script>
 *  <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
 * ============================================================
 */

/* global proj4, turf, Papa */

(function () {
  "use strict";

  const DAY = "2025-08-01";
  const TIMEZONE = "Asia/Tokyo";

  const GRID_KM = 5;
  const BATCH = 80;
  const BASE_DELAY_MS = 1200;
  const MAX_RETRIES = 8;

  const KYOTO_PREF_CODE = "26";
  const KYOTO_GEOJSON_RAW = `https://raw.githubusercontent.com/amay077/JapanPrefGeoJson/master/prefs/${KYOTO_PREF_CODE}.geojson`;

  const BASE_URL = "https://archive-api.open-meteo.com/v1/archive";
  const HOURLY = "temperature_2m,relative_humidity_2m,windspeed_10m,shortwave_radiation";

  const APP_ID = "app";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clamp(x, a, b) {
    return Math.min(b, Math.max(a, x));
  }

  function roundTo(x, d = 1) {
    const p = Math.pow(10, d);
    return Math.round(x * p) / p;
  }

  function keyLatLon(lat, lon) {
    return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  }

  function strictParseHourlyTimeISOZless(s) {
    if (typeof s !== "string") throw new Error("time parse failed: not string");
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
    if (!m) throw new Error(`time parse failed. sample=${s}`);
    const [_, yy, mo, dd, hh, mm] = m;
    return `${yy}-${mo}-${dd} ${hh}:${mm}`;
  }

  async function fetchWithRetry(url, params, maxRetries = MAX_RETRIES, baseDelayMs = BASE_DELAY_MS) {
    const u = new URL(url);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const resp = await fetch(u.toString());
      if (resp.ok) return resp;

      const st = resp.status;
      if (st === 429 || (st >= 500 && st < 600)) {
        const jitter = Math.random() * 700;
        const delay = Math.min(60000, baseDelayMs * Math.pow(1.6, attempt - 1) + jitter);
        console.warn(`${st} -> sleep ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})`);
        await sleep(delay);
        continue;
      }

      const body = (await resp.text()).slice(0, 300).replace(/\n/g, " ");
      throw new Error(`HTTP ${st}: ${body}`);
    }
    throw new Error("Failed to fetch after retries.");
  }

  function chunkArray(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function ensureDeps() {
    if (!window.proj4) throw new Error("proj4 not found. Load proj4 CDN first.");
    if (!window.turf) throw new Error("turf not found. Load @turf/turf CDN first.");
    if (!window.Papa) throw new Error("PapaParse not found. Load papaparse CDN first.");
  }

  function createTransformer() {
    if (!proj4.defs("EPSG:3857")) {
      proj4.defs(
        "EPSG:3857",
        "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +no_defs"
      );
    }
    const to3857 = (lon, lat) => proj4("EPSG:4326", "EPSG:3857", [lon, lat]);
    const to4326 = (x, y) => proj4("EPSG:3857", "EPSG:4326", [x, y]);
    return { to3857, to4326 };
  }

  function geojsonToFirstPolygonFeature(gj) {
    if (gj && Array.isArray(gj.features) && gj.features.length > 0) return gj.features[0];
    return gj;
  }

  function polygonBoundsLonLat(feature) {
    return turf.bbox(feature);
  }

  function buildMeshPointsInsidePolygon(feature, gridKm) {
    const { to3857, to4326 } = createTransformer();
    const [minx, miny, maxx, maxy] = polygonBoundsLonLat(feature);
    console.log("Kyoto bounds (lon/lat):", [minx, miny, maxx, maxy]);

    const [minx_m, miny_m] = to3857(minx, miny);
    const [maxx_m, maxy_m] = to3857(maxx, maxy);

    const step = gridKm * 1000;
    const pts = [];

    for (let x = minx_m; x <= maxx_m + step; x += step) {
      for (let y = miny_m; y <= maxy_m + step; y += step) {
        const [lon, lat] = to4326(x + step / 2, y + step / 2);
        const p = turf.point([lon, lat]);
        if (turf.booleanPointInPolygon(p, feature)) {
          pts.push({ lat, lon });
        }
      }
    }
    console.log(`mesh points inside Kyoto: ${pts.length} (GRID_KM=${gridKm}km)`);
    if (pts.length === 0) throw new Error("pts_raw is empty (mesh generation failed)");
    return pts;
  }

  function iterLocations(payload) {
    const out = [];
    if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object");
    if (!payload || typeof payload !== "object") return out;
    if (Array.isArray(payload.locations)) return payload.locations.filter((x) => x && typeof x === "object");
    if (Array.isArray(payload.results)) return payload.results.filter((x) => x && typeof x === "object");
    out.push(payload);
    return out;
  }

  async function fetchOpenMeteoArchiveForPoints(ptsRaw) {
    const batches = chunkArray(ptsRaw, BATCH);
    const allRows = [];

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      console.log(`[${bi + 1}/${batches.length}] fetching batch size=${batch.length} ...`);

      const lats = batch.map((p) => Number(p.lat).toFixed(5)).join(",");
      const lons = batch.map((p) => Number(p.lon).toFixed(5)).join(",");

      const params = {
        latitude: lats,
        longitude: lons,
        start_date: DAY,
        end_date: DAY,
        hourly: HOURLY,
        timezone: TIMEZONE,
      };

      const resp = await fetchWithRetry(BASE_URL, params);
      const payload = await resp.json();

      const locs = iterLocations(payload);
      for (const loc of locs) {
        try {
          const lat = Number(loc.latitude);
          const lon = Number(loc.longitude);
          const hourly = loc.hourly || {};

          const tRaw = hourly.time || [];
          const timeKey = tRaw.map(strictParseHourlyTimeISOZless);
          if (timeKey.some((x) => !x)) throw new Error(`time parse failed. sample=${String(tRaw[0])}`);

          const temp = (hourly.temperature_2m || []).map(Number);
          const rh = (hourly.relative_humidity_2m || []).map(Number);
          const ws10 = (hourly.windspeed_10m || []).map(Number);
          const swr = (hourly.shortwave_radiation || []).map(Number);

          const n = timeKey.length;
          if (!n || temp.length !== n || rh.length !== n || ws10.length !== n || swr.length !== n) continue;

          for (let i = 0; i < n; i++) {
            allRows.push({
              time_key: timeKey[i],
              lat,
              lon,
              temp: temp[i],
              rh: rh[i],
              windspeed_10m: ws10[i],
              shortwave_radiation: swr[i],
            });
          }
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes("time parse failed")) throw e;
          continue;
        }
      }
      await sleep(BASE_DELAY_MS);
    }

    console.log("wx rows:", allRows.length);
    return allRows;
  }

  function wetBulbStull(T, RH) {
    const rh = clamp(RH, 1e-6, 100.0);
    return (
      T * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(T + rh) -
      Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
      4.686035
    );
  }

  function wbgtOutdoorFromC(row, C) {
    const Ta = row.temp;
    const SR = Math.max(row.shortwave_radiation, 0.0);
    const WS = Math.max(row.windspeed_10m, 0.0);
    const Tw = row.tw;
    const Tg = Ta + C * (Math.sqrt(SR) / Math.sqrt(Math.max(WS + 0.5, 0.5)));
    return 0.7 * Tw + 0.2 * Tg + 0.1 * Ta;
  }

  async function loadKyotoEnvWbgtDay(dayStr) {
    const yyyymm = dayStr.replace(/-/g, "").slice(0, 6);
    const url = `https://www.wbgt.env.go.jp/est15WG/dl/wbgt_kyoto_${yyyymm}.csv`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch env wbgt csv: HTTP ${resp.status}`);
    const text = await resp.text();

    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    const rows = parsed.data;

    const byHour = new Map();
    for (const r of rows) {
      const DateStr = String(r.Date ?? "").trim();
      const TimeStr = String(r.Time ?? "").trim();
      if (!DateStr || !TimeStr) continue;

      const ds = DateStr.replace(/\//g, "-");
      const ts = TimeStr.padStart(5, "0");
      const dtKey = `${ds} ${ts}`;
      if (!dtKey.startsWith(dayStr)) continue;

      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(dtKey);
      if (!m) continue;
      const hourKey = `${m[1]} ${m[2]}:00`;

      let maxVal = -Infinity;
      for (const [k, v] of Object.entries(r)) {
        if (k === "Date" || k === "Time") continue;
        const num = Number(v);
        if (Number.isFinite(num)) maxVal = Math.max(maxVal, num);
      }
      if (!Number.isFinite(maxVal)) continue;

      const prev = byHour.get(hourKey);
      if (prev == null) byHour.set(hourKey, maxVal);
      else byHour.set(hourKey, Math.max(prev, maxVal));
    }
    return byHour;
  }

  function tuneC(wxRows, envHourMap) {
    const wxTimes = new Set(wxRows.map((r) => r.time_key));
    const common = [...envHourMap.keys()].filter((t) => wxTimes.has(t)).sort();
    if (common.length < 6) throw new Error(`共通時刻が少なすぎます: ${common.length}`);

    const envVec = common.map((t) => Number(envHourMap.get(t)));

    const Cgrid = [];
    for (let c = 0.5; c <= 6.0001; c += 0.1) Cgrid.push(roundTo(c, 2));

    let best = null;
    for (const C of Cgrid) {
      const repMap = new Map();
      const commonSet = new Set(common);
      for (const r of wxRows) {
        if (!commonSet.has(r.time_key)) continue;
        const wb = wbgtOutdoorFromC(r, C);
        const prev = repMap.get(r.time_key);
        if (prev == null) repMap.set(r.time_key, wb);
        else repMap.set(r.time_key, Math.max(prev, wb));
      }

      let sumAbs = 0, sumSq = 0, n = 0;
      for (let i = 0; i < common.length; i++) {
        const a = repMap.get(common[i]);
        const b = envVec[i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        sumAbs += Math.abs(a - b);
        sumSq += (a - b) * (a - b);
        n++;
      }
      if (n < 6) continue;

      const mae = sumAbs / n;
      const rmse = Math.sqrt(sumSq / n);
      const cand = { mae, rmse, C };
      if (!best || mae < best.mae || (mae === best.mae && rmse < best.rmse)) best = cand;
    }

    if (!best) throw new Error("チューニング失敗（比較できるデータが不足）");
    return { ...best, commonTimes: common };
  }

  function riskScoreFromWbgtCont(wbgt, age, met, waterMlLast2h) {
    const x = clamp((wbgt - 22.0) / 12.0, 0.0, 1.0);
    const base = 10.0 + 75.0 * x;

    const ageAdd = age >= 65 ? 10.0 : age < 15 ? 5.0 : 0.0;

    const metClamped = clamp(Number(met), 1.0, 10.0);
    const activityAdd = ((metClamped - 1.0) / 9.0) * 20.0;

    const ml = Math.max(0.0, Number(waterMlLast2h));
    const hydrationAdd = 18.0 * (1.0 - Math.min(1.0, ml / 600.0));

    const score = Math.min(100.0, base + ageAdd + activityAdd + hydrationAdd);
    const scoreDisp = roundTo(score, 1);

    let level = "危険";
    if (scoreDisp <= 24) level = "低";
    else if (scoreDisp <= 49) level = "注意";
    else if (scoreDisp <= 74) level = "警戒";
    else level = "危険";

    return { score: scoreDisp, level };
  }

  function recommendAction(level) {
    return {
      低: "通常注意：こまめに水分補給。",
      注意: "日陰・屋内を優先、30〜60分ごと休憩。",
      警戒: "外出/運動は時間をずらす（朝夕へ）。",
      危険: "今は避ける：屋内へ移動し活動は中止。",
    }[level];
  }

  const LEVEL_STYLE = {
    低: { bg: "#E8F5E9", fg: "#1B5E20" },
    注意: { bg: "#FFF8E1", fg: "#E65100" },
    警戒: { bg: "#FFEBEE", fg: "#B71C1C" },
    危険: { bg: "#4A148C", fg: "#FFFFFF" },
  };

  const ACTIVITY_PRESETS = [
    { label: "座って過ごす（1.2 MET）", met: 1.2 },
    { label: "立ち仕事・ゆっくり歩き（2.0 MET）", met: 2.0 },
    { label: "早歩き（3.3 MET）", met: 3.3 },
    { label: "観光で長く歩く（4.0 MET）", met: 4.0 },
    { label: "軽い運動（5.0 MET）", met: 5.0 },
    { label: "部活・ランニング（8.0 MET）", met: 8.0 },
    { label: "重労働（10.0 MET）", met: 10.0 },
  ];

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, String(v));
    }
    for (const c of children) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  function buildUI(root, ctx) {
    const { times, pts, timeToOutdoor, timeToShade, C_best, mae_best, rmse_best } = ctx;

    const state = {
      timeKey: times[0],
      mode: "outdoor",
      idx: 0,
      age: 30,
      activityLabel: "観光で長く歩く（4.0 MET）",
      waterMl: 0,
    };

    function currentMet() {
      return ACTIVITY_PRESETS.find((x) => x.label === state.activityLabel)?.met ?? 4.0;
    }

    function renderCard() {
      const p = pts[state.idx];
      const k = keyLatLon(p.lat, p.lon);

      const wbgt =
        state.mode === "outdoor"
          ? timeToOutdoor.get(state.timeKey)?.get(k)
          : timeToShade.get(state.timeKey)?.get(k);

      if (!Number.isFinite(wbgt)) {
        return el("div", { style: { padding: "12px" } }, [
          `この地点のWBGTが取得できていません（${state.timeKey} / ID ${state.idx}）`,
        ]);
      }

      const met = currentMet();
      const { score, level } = riskScoreFromWbgtCont(wbgt, state.age, met, state.waterMl);
      const style = LEVEL_STYLE[level];
      const action = recommendAction(level);

      const mapsUrl = `https://www.google.com/maps?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      const barW = clamp(score, 0, 100);

      return el(
        "div",
        {
          style: {
            padding: "14px",
            borderRadius: "12px",
            background: style.bg,
            color: style.fg,
            border: "1px solid rgba(0,0,0,0.08)",
            fontFamily: "system-ui",
          },
        },
        [
          el("div", { style: { fontSize: "14px", opacity: 0.9 } }, [
            `${state.timeKey} / 地点ID ${state.idx}（${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}） / ${
              state.mode === "outdoor" ? "屋外WBGT（tuned）" : "日陰WBGT（近似）"
            } `,
            el(
              "a",
              { href: mapsUrl, target: "_blank", rel: "noopener", style: { marginLeft: "8px", color: "inherit" } },
              ["地図で開く"]
            ),
          ]),
          el("div", { style: { fontSize: "20px", fontWeight: "700", marginTop: "6px" } }, [
            `リスクスコア：${score} / 100（${level}）`,
          ]),
          el("div", { style: { marginTop: "6px", fontSize: "14px" } }, [
            `WBGT：`,
            el("b", {}, [wbgt.toFixed(1)]),
            ` / 年齢：${state.age} / 行動：${state.activityLabel} / 水分：${Math.round(state.waterMl)}ml`,
          ]),
          el("div", { style: { marginTop: "10px", fontSize: "14px" } }, [
            "✅ 推奨アクション：",
            el("b", {}, [action]),
          ]),
          el(
            "div",
            {
              style: {
                marginTop: "10px",
                height: "10px",
                borderRadius: "999px",
                background: "rgba(0,0,0,0.10)",
                overflow: "hidden",
              },
            },
            [el("div", { style: { height: "10px", width: `${barW}%`, background: style.fg } })]
          ),
          el("div", { style: { marginTop: "10px", fontSize: "12px", opacity: 0.85 } }, [
            `C_best=${C_best.toFixed(2)}（環境省WBGT 京都府max(時刻1H化)に MAE=${mae_best.toFixed(
              2
            )}, RMSE=${rmse_best.toFixed(2)} で合わせ込み）`,
          ]),
        ]
      );
    }

    const title = el("div", { style: { fontWeight: "700", marginBottom: "10px" } }, [
      `対象日：${DAY}（Open-Meteo: temp/rh/wind/solar → WBGT）`,
    ]);

    const timeSel = el("select", { style: { padding: "6px", minWidth: "180px" } });
    for (const t of times) timeSel.appendChild(el("option", { value: t }, [t]));
    timeSel.value = state.timeKey;
    timeSel.addEventListener("change", () => {
      state.timeKey = timeSel.value;
      repaint();
    });

    const modeSel = el("select", { style: { padding: "6px", minWidth: "220px", marginLeft: "8px" } });
    modeSel.appendChild(el("option", { value: "outdoor" }, ["屋外WBGT（風＋日射・Cチューニング）"]));
    modeSel.appendChild(el("option", { value: "shade" }, ["日陰WBGT近似（湿球＋乾球）"]));
    modeSel.value = state.mode;
    modeSel.addEventListener("change", () => {
      state.mode = modeSel.value;
      repaint();
    });

    const idxInput = el("input", {
      type: "range",
      min: "0",
      max: String(Math.max(0, pts.length - 1)),
      step: "1",
      value: String(state.idx),
      style: { width: "360px" },
    });
    const idxLabel = el("span", { style: { marginLeft: "8px" } }, [`地点ID: ${state.idx}`]);
    idxInput.addEventListener("input", () => {
      state.idx = Number(idxInput.value);
      idxLabel.textContent = `地点ID: ${state.idx}`;
      repaint();
    });

    const ageInput = el("input", {
      type: "range",
      min: "5",
      max: "90",
      step: "1",
      value: "30",
      style: { width: "360px" },
    });
    const ageLabel = el("span", { style: { marginLeft: "8px" } }, [`年齢: ${state.age}`]);
    ageInput.addEventListener("input", () => {
      state.age = Number(ageInput.value);
      ageLabel.textContent = `年齢: ${state.age}`;
      repaint();
    });

    const actSel = el("select", { style: { padding: "6px", minWidth: "260px" } });
    for (const a of ACTIVITY_PRESETS) actSel.appendChild(el("option", { value: a.label }, [a.label]));
    actSel.value = state.activityLabel;
    actSel.addEventListener("change", () => {
      state.activityLabel = actSel.value;
      repaint();
    });

    const waterLabel = el("span", {}, [`水分(直近2h): ${state.waterMl} ml`]);
    const btn200 = el("button", { style: { marginLeft: "8px" } }, ["+200ml"]);
    const btn500 = el("button", { style: { marginLeft: "6px" } }, ["+500ml"]);
    const btnReset = el("button", { style: { marginLeft: "6px" } }, ["リセット"]);

    btn200.addEventListener("click", () => {
      state.waterMl += 200;
      waterLabel.textContent = `水分(直近2h): ${state.waterMl} ml`;
      repaint();
    });
    btn500.addEventListener("click", () => {
      state.waterMl += 500;
      waterLabel.textContent = `水分(直近2h): ${state.waterMl} ml`;
      repaint();
    });
    btnReset.addEventListener("click", () => {
      state.waterMl = 0;
      waterLabel.textContent = `水分(直近2h): ${state.waterMl} ml`;
      repaint();
    });

    const cardHost = el("div", { style: { marginTop: "12px" } });

    function repaint() {
      cardHost.innerHTML = "";
      cardHost.appendChild(renderCard());
    }

    root.innerHTML = "";
    root.appendChild(
      el("div", { style: { fontFamily: "system-ui", padding: "12px" } }, [
        title,
        el("div", {}, [
          el("span", { style: { fontSize: "12px", opacity: 0.8, marginRight: "8px" } }, ["時刻"]),
          timeSel,
          el("span", { style: { fontSize: "12px", opacity: 0.8, marginLeft: "12px", marginRight: "8px" } }, ["WBGT"]),
          modeSel,
        ]),
        el("div", { style: { marginTop: "10px" } }, [
          el("div", { style: { fontSize: "12px", opacity: 0.8 } }, ["地点ID"]),
          idxInput,
          idxLabel,
        ]),
        el("div", { style: { marginTop: "10px" } }, [
          el("div", { style: { fontSize: "12px", opacity: 0.8 } }, ["年齢"]),
          ageInput,
          ageLabel,
        ]),
        el("div", { style: { marginTop: "10px" } }, [
          el("div", { style: { fontSize: "12px", opacity: 0.8, marginBottom: "4px" } }, ["行動"]),
          actSel,
        ]),
        el("div", { style: { marginTop: "10px" } }, [waterLabel, btn200, btn500, btnReset]),
        cardHost,
      ])
    );

    repaint();
  }

  async function buildAll() {
    ensureDeps();

    const app = document.getElementById(APP_ID);
    if (!app) throw new Error(`Missing <div id="${APP_ID}"></div>`);
    app.innerHTML = `<div style="font-family:system-ui;padding:12px;">準備中...</div>`;

    const gjResp = await fetch(KYOTO_GEOJSON_RAW);
    if (!gjResp.ok) throw new Error(`Failed geojson fetch: HTTP ${gjResp.status}`);
    const gj = await gjResp.json();
    const feature = geojsonToFirstPolygonFeature(gj);

    const ptsRaw = buildMeshPointsInsidePolygon(feature, GRID_KM);

    app.innerHTML = `<div style="font-family:system-ui;padding:12px;">気象データ取得中（地点=${ptsRaw.length}）...</div>`;
    const wxRows0 = await fetchOpenMeteoArchiveForPoints(ptsRaw);

    const wxRows = wxRows0.map((r) => {
      const tw = wetBulbStull(r.temp, r.rh);
      const wbgtShade = 0.7 * tw + 0.3 * r.temp;
      return { ...r, tw, wbgt_shade: wbgtShade };
    });

    app.innerHTML = `<div style="font-family:system-ui;padding:12px;">環境省WBGT取得＆チューニング中...</div>`;
    const envHourMap = await loadKyotoEnvWbgtDay(DAY);
    const tuned = tuneC(wxRows, envHourMap);

    const C_best = tuned.C;
    const mae_best = tuned.mae;
    const rmse_best = tuned.rmse;

    for (const r of wxRows) {
      r.wbgt_outdoor_tuned = wbgtOutdoorFromC(r, C_best);
    }

    const uniqMap = new Map();
    for (const r of wxRows) {
      const k = keyLatLon(r.lat, r.lon);
      if (!uniqMap.has(k)) uniqMap.set(k, { lat: r.lat, lon: r.lon });
    }
    const pts = [...uniqMap.values()].sort((a, b) => (a.lat - b.lat) || (a.lon - b.lon));

    const times = [...new Set(wxRows.map((r) => r.time_key))].sort();

    const timeToOutdoor = new Map();
    const timeToShade = new Map();
    for (const t of times) {
      timeToOutdoor.set(t, new Map());
      timeToShade.set(t, new Map());
    }
    for (const r of wxRows) {
      const t = r.time_key;
      const k = keyLatLon(r.lat, r.lon);
      const mo = timeToOutdoor.get(t);
      const ms = timeToShade.get(t);
      if (mo && !mo.has(k)) mo.set(k, r.wbgt_outdoor_tuned);
      if (ms && !ms.has(k)) ms.set(k, r.wbgt_shade);
    }

    buildUI(app, { times, pts, timeToOutdoor, timeToShade, C_best, mae_best, rmse_best });
  }

  window.addEventListener("DOMContentLoaded", () => {
    buildAll().catch((e) => {
      console.error(e);
      const app = document.getElementById(APP_ID);
      if (app) {
        app.innerHTML = `<div style="font-family:system-ui;padding:12px;color:#B71C1C;">
          エラー: ${String(e.message || e)}
          <div style="margin-top:8px;font-size:12px;opacity:0.85;">
            依存CDN（proj4/turf/papaparse）と、CORS/ネットワークを確認してください。
          </div>
        </div>`;
      }
    });
  });
})();

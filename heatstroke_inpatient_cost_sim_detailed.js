// heatstroke_inpatient_cost_sim_detailed.js
//
// 追加機能：合計だけでなく「内訳（何にいくら）」を配列で出力する．
// 既存機能（simulateInpatientCost）は維持し，simulateInpatientCostDetailed を追加する．
//
// 注意：本モデルは概算シミュレーション．
// - 病院係数，出来高分，加算，入院時食事療養費，差額ベッド代等はモデル化していない．
// - DPC 161020（体温異常）には熱中症以外（低体温等）も含み得る．

// ===== 固定仮定 =====
const DEFAULT_ASSUMPTIONS = {
  copayRate: 0.3, // 3割固定（ユーザー指定）
  // 高額療養費（年収約370〜770万円区分）の上限式（多数回該当は無視）
  highCostBaseYen: 80100,
  highCostThresholdYen: 267000,
  highCostMarginalRate: 0.01,

  // 限度額適用あり（窓口支払いを上限までに抑える前提）
  limitCertificate: true,

  // 月跨ぎなし，初回想定（多数回該当なし）
  ignoreManyTimes: true,

  // 入院のみ
  inpatientOnly: true,

  weekdayDaytime: true,
  noComorbidity: true,

  // 現場時間（観測できないので固定仮定）
  onSceneMin: 10,
};

// ===== DPC 161020 点数（抜粋） =====
// 161020xxxxx00x：入院期間I=2, II=5, III=30，点数/日=3830,2132,1812
// 161020xxxxx1xx：入院期間I=5, II=16, III=60，点数/日=4738,2255,1917
const DPC_161020 = {
  "161020xxxxx00x": {
    variant: "161020xxxxx00x",
    dayI: 2,
    dayII: 5,
    dayIII: 30,
    pointsI: 3830,
    pointsII: 2132,
    pointsIII: 1812,
  },
  "161020xxxxx1xx": {
    variant: "161020xxxxx1xx",
    dayI: 5,
    dayII: 16,
    dayIII: 60,
    pointsI: 4738,
    pointsII: 2255,
    pointsIII: 1917,
  },
};

// ===== 参考中央値（スケーリング用） =====
const BASELINE_MEDIAN_CLAIM_POINTS = 28438;
const BASELINE_REF_VARIANT = "161020xxxxx00x";
const BASELINE_REF_LOS_DAYS = 6;

// ===== ユーティリティ =====
function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function sigmoid(x) {
  if (x > 50) return 1;
  if (x < -50) return 0;
  return 1 / (1 + Math.exp(-x));
}

function pointsToYen(points) {
  // 1点=10円
  return Math.round(points * 10);
}

function normalizeRange(x, lo, hi) {
  if (!Number.isFinite(x)) return 0;
  if (hi <= lo) return 0;
  return clamp01((x - lo) / (hi - lo));
}

function calcPerDiemPoints(variant, losDays) {
  if (!Number.isFinite(losDays) || losDays < 1) {
    throw new Error("losDays must be >= 1");
  }
  const r = DPC_161020[variant];
  if (!r) throw new Error("unknown variant: " + variant);

  let pts = 0;
  const n = Math.floor(losDays);

  for (let d = 1; d <= n; d++) {
    if (d <= r.dayI) pts += r.pointsI;
    else if (d <= r.dayII) pts += r.pointsII;
    else if (d <= r.dayIII) pts += r.pointsIII;
    else {
      // dayIII超は出来高等へ移行し得るため，簡易モデルでは加算しない
    }
  }
  return pts;
}

function calcHighCostCapYen(totalMedicalCostYen, a = DEFAULT_ASSUMPTIONS) {
  // 平均所得（年収約370〜770万円・3割）の上限式
  // cap = 80,100 + max(0, total - 267,000)*1%
  const extra =
    Math.max(0, totalMedicalCostYen - a.highCostThresholdYen) * a.highCostMarginalRate;
  return Math.floor(a.highCostBaseYen + extra);
}

function calcOutOfPocketYen(totalMedicalCostYen, a = DEFAULT_ASSUMPTIONS) {
  const raw = Math.round(totalMedicalCostYen * a.copayRate);
  const cap = calcHighCostCapYen(totalMedicalCostYen, a);
  const finalYen = a.limitCertificate ? Math.min(raw, cap) : raw;
  return { rawCopayYen: raw, capYen: cap, finalCopayYen: finalYen };
}

function estimateClaimPointsFromLos(variant, losDays) {
  // DPC点数表で積算した「相対比」を使って，中央値（28438点）からスケールさせる
  const refPts = calcPerDiemPoints(BASELINE_REF_VARIANT, BASELINE_REF_LOS_DAYS);
  const pts = calcPerDiemPoints(variant, losDays);
  const factor = pts / refPts;
  return BASELINE_MEDIAN_CLAIM_POINTS * factor;
}

// ===== 追加：DPC包括の内訳（期間I/II/III）を作る =====
function calcPerDiemBreakdownRaw(variant, losDays) {
  // ここでの points は「点数表そのまま」の積み上げ（未スケール）
  const r = DPC_161020[variant];
  if (!r) throw new Error("unknown variant: " + variant);

  const n = Math.floor(losDays);
  const dI = Math.max(0, Math.min(n, r.dayI));
  const dII = Math.max(0, Math.min(n, r.dayII) - r.dayI);
  const dIII = Math.max(0, Math.min(n, r.dayIII) - r.dayII);

  const pI = dI * r.pointsI;
  const pII = dII * r.pointsII;
  const pIII = dIII * r.pointsIII;

  const total = pI + pII + pIII;

  return {
    variant,
    losDays: n,
    periods: [
      {
        key: "inclusive_period_I",
        label: "DPC包括：入院期間I（1日点数×日数）",
        days: dI,
        pointsPerDay: r.pointsI,
        points: pI,
      },
      {
        key: "inclusive_period_II",
        label: "DPC包括：入院期間II（1日点数×日数）",
        days: dII,
        pointsPerDay: r.pointsII,
        points: pII,
      },
      {
        key: "inclusive_period_III",
        label: "DPC包括：入院期間III（1日点数×日数）",
        days: dIII,
        pointsPerDay: r.pointsIII,
        points: pIII,
      },
    ],
    totalPointsRaw: total,
    note:
      "dayIII超や出来高算定分（検査・処置・加算等）は本モデルに含めない．",
  };
}

function getScalingConstantK() {
  // estPts = BASELINE_MEDIAN_CLAIM_POINTS * (pts / refPts)
  // よって，点数表の pts を k 倍すれば「推定請求点数」に一致する
  const refPts = calcPerDiemPoints(BASELINE_REF_VARIANT, BASELINE_REF_LOS_DAYS);
  return BASELINE_MEDIAN_CLAIM_POINTS / refPts;
}

function scaleBreakdownToEstimated(breakdownRaw) {
  const k = getScalingConstantK();

  const periodsScaled = breakdownRaw.periods.map((p) => {
    const estPoints = p.points * k;
    return {
      key: p.key,
      label: p.label,
      days: p.days,
      pointsPerDay_table: p.pointsPerDay, // 点数表上の1日点数
      points_table: p.points,             // 点数表上の合計点数
      points_est: estPoints,              // 推定請求点数（スケール後）
      yen_est: pointsToYen(estPoints),    // 推定金額（10割）
    };
  });

  const totalPointsEst = breakdownRaw.totalPointsRaw * k;
  const totalYenEst = pointsToYen(totalPointsEst);

  return {
    variant: breakdownRaw.variant,
    losDays: breakdownRaw.losDays,
    scaling_k: k,
    medical_breakdown: periodsScaled,
    medical_total: {
      points_est: totalPointsEst,
      yen_est: totalYenEst,
      label: "推定総医療費（保険適用分・10割，DPC包括のみ）",
    },
    note: breakdownRaw.note,
  };
}

// ===== 追加：自己負担の内訳 =====
function buildOutOfPocketBreakdown(totalMedicalCostYen, a = DEFAULT_ASSUMPTIONS) {
  const oop = calcOutOfPocketYen(totalMedicalCostYen, a);

  const benefit = Math.max(0, oop.rawCopayYen - oop.finalCopayYen);
  const systemBurden = Math.max(0, totalMedicalCostYen - oop.finalCopayYen); // 参考：制度側負担（概算）

  const items = [
    {
      key: "raw_copay",
      label: `窓口負担（${Math.round(a.copayRate * 100)}%）の計算結果`,
      yen: oop.rawCopayYen,
      note:
        "限度額適用が無い場合はこの額を一時的に支払い，後日還付となる可能性がある．",
    },
    {
      key: "high_cost_cap",
      label: "高額療養費の自己負担上限（月，上限式）",
      yen: oop.capYen,
      note:
        "本モデルは平均所得（年収約370〜770万円）区分を固定し，多数回該当・月跨ぎは無視している．",
    },
    {
      key: "final_out_of_pocket",
      label: "最終自己負担（限度額適用あり想定）",
      yen: oop.finalCopayYen,
      note:
        "限度額適用ありの場合，窓口負担は上限までに抑えられる想定．",
    },
    {
      key: "estimated_benefit",
      label: "高額療養費による給付見込み（概算）",
      yen: benefit,
      note:
        "raw_copay - final_out_of_pocket．実際の給付手続き・適用条件により変動し得る．",
    },
    {
      key: "estimated_system_burden",
      label: "制度側負担（総医療費 - 最終自己負担，参考）",
      yen: systemBurden,
      note:
        "医療機関に支払われる総額のうち，最終自己負担以外の部分（保険者負担＋高額療養費相当）．",
    },
  ];

  return {
    out_of_pocket_total: oop.finalCopayYen,
    capYen: oop.capYen,
    rawCopayYen: oop.rawCopayYen,
    finalCopayYen: oop.finalCopayYen,
    out_of_pocket_breakdown: items,
  };
}

// ===== 既存：入院費シミュレーション（合計のみ） =====
function simulateInpatientCost(input, a = DEFAULT_ASSUMPTIONS) {
  // 1) 病院着までの推定（簡易）
  const tHospMin = input.ambulanceArrivalMin + input.transportMin + a.onSceneMin;

  // 2) 重症度スコア（0..1）
  const sTime = sigmoid((tHospMin - 55) / 12);
  const sWbgt = normalizeRange(input.wbgt, 28, 34);
  const sAct = normalizeRange(input.mets * input.outingHours, 6, 18);
  const sWater = normalizeRange(input.waterIntakeMl, 0, 1000);

  const severityScore01 = clamp01(0.6 * sTime + 0.2 * sWbgt + 0.2 * sAct - 0.2 * sWater);

  // 3) シナリオ確率（滑らかに）
  let pLow = (1 - severityScore01) * (1 - severityScore01);
  let pHigh = severityScore01 * severityScore01;
  let pMid = 1 - pLow - pHigh;
  if (pMid < 0) pMid = 0;

  const sum = pLow + pMid + pHigh;
  pLow /= sum;
  pMid /= sum;
  pHigh /= sum;

  // 4) シナリオ定義（入院日数はプレゼン用の代表値）
  const defs = [
    { name: "LOW", variant: "161020xxxxx00x", losDays: 3, probability: pLow },
    { name: "MID", variant: "161020xxxxx00x", losDays: 6, probability: pMid },
    { name: "HIGH", variant: "161020xxxxx1xx", losDays: 12, probability: pHigh },
  ];

  const scenarios = defs.map((d) => {
    const estClaimPoints = estimateClaimPointsFromLos(d.variant, d.losDays);
    const estTotalMedicalCostYen = pointsToYen(estClaimPoints);
    const oop = calcOutOfPocketYen(estTotalMedicalCostYen, a);
    return {
      name: d.name,
      variant: d.variant,
      losDays: d.losDays,
      probability: d.probability,
      estClaimPoints,
      estTotalMedicalCostYen,
      oop, // {rawCopayYen, capYen, finalCopayYen}
    };
  });

  const expectedTotalMedicalCostYen = Math.round(
    scenarios.reduce((acc, s) => acc + s.probability * s.estTotalMedicalCostYen, 0)
  );
  const expectedOutOfPocketYen = Math.round(
    scenarios.reduce((acc, s) => acc + s.probability * s.oop.finalCopayYen, 0)
  );

  const notes = [
    "本結果はDPC・高額療養費に基づく簡易シミュレーション（概算）です．",
    "DPC 161020（体温異常）には熱中症以外（低体温等）も含み得ます．",
    "病院係数，出来高分，入院時食事療養費，差額ベッド代等はモデル化していません．",
    "『時間が遅いほど重症化』は相関の雰囲気であり，個別の医学的予測ではありません．",
  ];

  return {
    tHospMin,
    severityScore01,
    scenarios,
    expected: {
      totalMedicalCostYen: expectedTotalMedicalCostYen,
      outOfPocketYen: expectedOutOfPocketYen,
    },
    notes,
  };
}

// ===== 追加：詳細内訳付きシミュレーション（既存結果＋breakdownsを追加） =====
function simulateInpatientCostDetailed(input, a = DEFAULT_ASSUMPTIONS) {
  const base = simulateInpatientCost(input, a);

  const scenariosDetailed = base.scenarios.map((s) => {
    // 1) 医療費（10割）内訳：期間I/II/III
    const raw = calcPerDiemBreakdownRaw(s.variant, s.losDays);
    const scaled = scaleBreakdownToEstimated(raw);

    // 2) 自己負担内訳：3割→上限→最終
    const oopBreak = buildOutOfPocketBreakdown(scaled.medical_total.yen_est, a);

    // 3) 追加で合計の整合（既存のestTotalMedicalCostYenと概ね一致）
    //    ※スケーリングが同一なので，理論上一致する（丸めで差が出る可能性あり）
    const consistency = {
      estTotalMedicalCostYen_from_base: s.estTotalMedicalCostYen,
      estTotalMedicalCostYen_from_breakdown: scaled.medical_total.yen_est,
      diffYen: scaled.medical_total.yen_est - s.estTotalMedicalCostYen,
    };

    return {
      ...s,
      breakdowns: {
        medical: scaled,          // DPC包括内訳（推定10割）
        out_of_pocket: oopBreak,  // 自己負担内訳（上限反映）
        consistency,
      },
    };
  });

  // 期待値の内訳も作る（項目ごとの期待値）
  // medical: 期間I/II/IIIの期待値（円）
  // oop: raw/cap/final/benefit の期待値（円）
  const expMedicalByKey = new Map();
  const expOopByKey = new Map();

  for (const s of scenariosDetailed) {
    const p = s.probability;

    // medical items
    for (const item of s.breakdowns.medical.medical_breakdown) {
      const prev = expMedicalByKey.get(item.key) || 0;
      expMedicalByKey.set(item.key, prev + p * item.yen_est);
    }

    // oop items
    for (const item of s.breakdowns.out_of_pocket.out_of_pocket_breakdown) {
      const prev = expOopByKey.get(item.key) || 0;
      expOopByKey.set(item.key, prev + p * item.yen);
    }
  }

  const expectedBreakdowns = {
    medical_breakdown_expected: Array.from(expMedicalByKey.entries()).map(([key, yen]) => ({
      key,
      yen: Math.round(yen),
    })),
    out_of_pocket_breakdown_expected: Array.from(expOopByKey.entries()).map(([key, yen]) => ({
      key,
      yen: Math.round(yen),
    })),
  };

  return {
    ...base,
    scenarios: scenariosDetailed,
    expectedBreakdowns,
  };
}

// ===== 使い方例 =====
// const result = simulateInpatientCostDetailed({
//   age: 22,
//   wbgt: 32,
//   waterIntakeMl: 200,
//   outingHours: 2,
//   mets: 6,
//   ambulanceArrivalMin: 10,
//   transportMin: 20,
// });
// console.log(JSON.stringify(result, null, 2));

// ===== exports（Node / bundler） =====
const api = {
  DEFAULT_ASSUMPTIONS,
  DPC_161020,
  BASELINE_MEDIAN_CLAIM_POINTS,
  calcPerDiemPoints,
  calcHighCostCapYen,
  calcOutOfPocketYen,
  estimateClaimPointsFromLos,
  simulateInpatientCost,
  // 追加
  calcPerDiemBreakdownRaw,
  scaleBreakdownToEstimated,
  buildOutOfPocketBreakdown,
  simulateInpatientCostDetailed,
};

// CommonJS
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

// ブラウザグローバル
if (typeof window !== "undefined") {
  window.heatstrokeInpatientCostSim = api;
}
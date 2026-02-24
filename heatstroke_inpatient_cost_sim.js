// heatstroke_inpatient_cost_sim.js
//
// 目的：熱中症（ICD-10:T67$を含み得る）想定の「入院費（自己負担）」を，
//      簡易シナリオ（軽/中/重）＋救急到着/搬送時間に相関した重症化でシミュレーションする．
//
// ⚠️注意：これは医療費を「正確に予測」するものではなく，プレゼン用の概算シミュレーション．
//       病院係数，出来高算定分，入院時食事療養費，差額ベッド代等で現実の請求は変動する．
//
// 根拠（参照用URL；コード内で参照する数値の根拠）
// - DPC 161020（体温異常）点数：厚労省「診断群分類点数表」等
//   https://www.mhlw.go.jp/content/12404000/001230352.pdf
// - DPCデータ（参考中央値）：在院日数中央値6日・請求点数中央値28438点（※集計対象の注記が必要）
//   https://www.mhlw.go.jp/content/12404000/001512944.pdf
// - 1点=10円（診療報酬）
//   https://www.mhlw.go.jp/web/t_doc?dataId=84aa9729&dataType=0
// - 高額療養費（年収約370〜770万円の例：80,100円+(医療費-267,000円)*1%）
//   https://www.mhlw.go.jp/content/12401000/001492935.pdf
// - 「発症→病院着」時間と転帰の関連（重症群解析の一例）
//   https://www.jstage.jst.go.jp/article/jjaam/21/9/21_9_786/_pdf
//
// 仕様（ユーザー指定の固定条件）
// - 入院のみ（外来は除外）
// - 合併症/既往歴なし（平均扱い）
// - 平日日中（加算などは平均扱いで明示的には入れない）
// - 設備は整っている（平均扱い）
// - 公費なし，多数回該当なし，月跨ぎなし
// - 限度額適用あり
// - 自己負担割合は 3割で固定（年齢に関わらず固定する指定）
// - 所得は平均（年収約370〜770万円の区分）で固定
//
// 入力（アプリ側で持っているとされたもの）
// - WBGT，年齢，水分摂取量，外出時間，METs，到着時間，搬送時間
//
// 出力
// - 病院着推定時間 tHosp
// - 重症度スコア（0..1）
// - 3つの入院シナリオ（軽/中/重）それぞれの確率・総医療費（概算）・自己負担（上限適用）
// - 期待値（総医療費・自己負担）
//
// ------------------------------------------------------------

// ===== 固定仮定 =====
const DEFAULT_ASSUMPTIONS = {
  copayRate: 0.3, // 3割固定（ユーザー指定）
  // 高額療養費（年収約370〜770万円区分）の上限式（多数回該当は無視）
  highCostBaseYen: 80100,
  highCostThresholdYen: 267000,
  highCostMarginalRate: 0.01,

  // 限度額適用あり（窓口支払いを上限までに抑える前提）
  limitCertificate: true,

  // 月跨ぎなし，初回想定
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
  const extra = Math.max(0, totalMedicalCostYen - a.highCostThresholdYen) * a.highCostMarginalRate;
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

// ===== メイン：入院費シミュレーション =====
/**
 * @param {Object} input
 * @param {number} input.age 年齢（今回の仕様では自己負担3割固定なので計算には使わないが保持）
 * @param {number} input.wbgt WBGT（例：℃）
 * @param {number} input.waterIntakeMl 外出中の水分摂取量（mL）
 * @param {number} input.outingHours 外出時間（時間）
 * @param {number} input.mets METs
 * @param {number} input.ambulanceArrivalMin 救急車の現場到着まで（分）
 * @param {number} input.transportMin 搬送時間（分）
 * @param {Object} [a] 固定仮定（省略可）
 */
function simulateInpatientCost(input, a = DEFAULT_ASSUMPTIONS) {
  // 1) 病院着までの推定（簡易）
  const tHospMin = input.ambulanceArrivalMin + input.transportMin + a.onSceneMin;

  // 2) 重症度スコア（0..1）
  //    文献の「38分 vs 70分」観測を意識して，55分を中点にS字で増加（厳密ではない）
  const sTime = sigmoid((tHospMin - 55) / 12); // 40→低，70→高の雰囲気
  //    WBGTは演出用：28〜34で上がるように正規化（閾値は仮定）
  const sWbgt = normalizeRange(input.wbgt, 28, 34);
  //    活動は METs×時間（例：6〜18を正規化；仮定）
  const sAct = normalizeRange(input.mets * input.outingHours, 6, 18);
  //    水分は多いほど下がる方向（0〜1000mLを正規化；仮定）
  const sWater = normalizeRange(input.waterIntakeMl, 0, 1000);

  // 重み：時間を主因にしつつ，他も少し反映
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
  //    LOW/MIDは00x，HIGHは1xx（人工呼吸等を含み得る側）に寄せる
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
    "『時間が遅いほど重症化』は文献知見を参考にした相関の雰囲気であり，個別の医学的予測ではありません．",
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

// ===== 使い方例 =====
// const result = simulateInpatientCost({
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
  clamp01,
  sigmoid,
  pointsToYen,
  calcPerDiemPoints,
  calcHighCostCapYen,
  calcOutOfPocketYen,
  estimateClaimPointsFromLos,
  simulateInpatientCost,
};

// CommonJS
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

// ESM (環境によっては bundler が拾う)
try {
  // eslint-disable-next-line no-undef
  if (typeof exports !== "undefined") {
    // noop
  }
} catch (_) {
  // noop
}

// ブラウザグローバル
if (typeof window !== "undefined") {
  window.heatstrokeInpatientCostSim = api;
}
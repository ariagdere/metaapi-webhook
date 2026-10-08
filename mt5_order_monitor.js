const MetaApi = require('metaapi.cloud-sdk').default;
const { Pool } = require('pg');
const { LsrSeries } = require('./lsrAngle');
const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const databaseUrl = process.env.DATABASE_URL;
const expiryHours = parseInt(process.env.PENDING_EXPIRY_HOURS || '72', 10);
const notifyWebhookUrl = process.env.NOTIFY_WEBHOOK_URL || 'https://hook.eu2.make.com/nc9p8mvzsn46mqolimwfpktp9yqpzt28';
const api = new MetaApi(token, { region: 'london' });
const pool = new Pool({ connectionString: databaseUrl });
const seenDeals = new Set();
const prevOrders = new Map();
const prevPositions = new Map();
// Magic -> strateji etiketi. Yeni strateji eklemek icin buraya satir ekle + redeploy.
const STRATEGY_MAP = {
  6130450: 'V6_Latest 50+',
  6310560: 'V6 60+',
  6310570: 'V6 70+',
  68040: 'V6 80+ 40-',
  65050: 'V6 50- 50+',
  7575: 'NAIF + ZLEMA',
};
function resolveStrategyLabel(magic) {
  return STRATEGY_MAP[Number(magic)] || null;
}
// Dashboard'un /live emir panelinden acilan emirler. hakari-dashboard lib/panelOrder.ts ile
// AYNI kurallar -- birinde degisirse digerinde de degismeli.
//   magic 9100, clientId "HK_<10 karakter a-z0-9>_1". MetaApi SL/TP ile kapanan islemlerde
//   clientId'nin son parcasini degistirebildigi icin eslestirme ilk iki parca uzerinden.
const PANEL_MAGIC = 9100;
function isPanelMagic(magic) {
  return Number(magic) === PANEL_MAGIC;
}
function panelClientKey(clientId) {
  if (typeof clientId !== 'string' || !clientId.startsWith('HK_')) return null;
  const parts = clientId.split('_');
  if (parts.length < 2 || !/^[a-z0-9]{10}$/.test(parts[1])) return null;
  return `${parts[0]}_${parts[1]}`;
}
// Panel emrinin strateji etiketi: dashboard emri gondermeden ONCE order_intents'e yazar.
// Bu servis tabloyu SADECE okur. Tablo yoksa / eslesme yoksa null -- order yine kaydedilir.
async function getPanelIntent(clientId) {
  const key = panelClientKey(clientId);
  if (!key) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id, strategy_label FROM order_intents WHERE client_key = $1`,
      [key]
    );
    return rows[0] || null;
  } catch (err) {
    console.error(`getPanelIntent hatası (clientId=${clientId}):`, err.message);
    return null;
  }
}
// Deal/emrin kaynagi. Panel emrinde etiket order_intents'ten gelir ve analiz/apify bagi yoktur:
// MetaApi clientId'yi MT5'in comment alaninda sakladigi icin comment OKUNMAZ (yoksa
// apify_run_id'ye clientId yazilirdi). Diger emirlerde eski kurallar (comment + magic).
// hakari-dashboard lib/reconcileHelpers.ts resolveDealOrigin ile AYNI.
async function resolveOrigin(item) {
  const panelIntent = await getPanelIntent(item.clientId);
  const isPanel = panelIntent != null || panelClientKey(item.clientId) != null || isPanelMagic(item.magic);
  const { analysisId, apifyRunId } = isPanel
    ? { analysisId: null, apifyRunId: null }
    : parseCommentField(item.comment ?? item.brokerComment);
  const strategyLabel = (panelIntent && panelIntent.strategy_label) || resolveStrategyLabel(item.magic);
  const isSystem = analysisId != null || apifyRunId != null || strategyLabel != null;
  return { isPanel, analysisId, apifyRunId, strategyLabel, isSystem };
}
function positiveOrNull(x) {
  const n = Number(x);
  return x != null && Number.isFinite(n) && n > 0 ? n : null;
}
// Comment iki şekilde gelebilir:
//  - Düz sayı  -> mevcut stratejiler, analysis_id order açılırken zaten biliniyor
//  - Diğer string -> Naif Aligned gibi hızlı yol stratejileri, apify_run_id
// String("123") === "123" kontrolü, "123abc" gibi kısmi sayısal string'lerin
// yanlışlıkla analysis_id sanılmasını engeller (parseInt baştaki rakamları
// keser, biz TAM sayı eşleşmesi istiyoruz).
function parseCommentField(comment) {
  if (comment == null) return { analysisId: null, apifyRunId: null };
  const s = String(comment).trim();
  if (!s) return { analysisId: null, apifyRunId: null };
  const n = parseInt(s, 10);
  if (!Number.isNaN(n) && String(n) === s) {
    return { analysisId: n, apifyRunId: null };
  }
  return { analysisId: null, apifyRunId: s };
}
function createSafeListener(handler) {
  return new Proxy(handler, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => {};
    }
  });
}
function calculateRR(entry, sl, tp) {
  if (!entry || !sl || !tp) return null;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return null;
  return Number((reward / risk).toFixed(2));
}
// -------------------- DB HELPERS --------------------
async function getOrderByMt5Id(mt5OrderId) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE mt5_order_id = $1`,
    [String(mt5OrderId)]
  );
  return rows[0] || null;
}
async function getOrderByPositionId(positionId) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE mt5_position_id = $1`,
    [String(positionId)]
  );
  return rows[0] || null;
}
async function insertOrderEvent(orderId, eventType, opts = {}, db = pool) {
  await db.query(
    `INSERT INTO order_events
       (order_id, event_type, is_manual, old_value, new_value, price, profit, source, raw_payload, event_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, $10)`,
    [
      orderId,
      eventType,
      opts.isManual ?? false,
      opts.oldValue ?? null,
      opts.newValue ?? null,
      opts.price ?? null,
      opts.profit ?? null,
      opts.source ?? 'streaming',
      opts.rawPayload ? JSON.stringify(opts.rawPayload) : null,
      opts.eventTime ?? new Date(), // deal.time varsa GERCEK islem anini kullan, yoksa simdi
    ]
  );
}
// analysis'in orijinal entry/sl'inden sizing_risk_distance hesaplayip
// r_target (TP olursa kazanc) ve r_risk (SL olursa kayip) turetir.
// Normal trade'de bu, order'in kendi entry/sl/tp'siyle ayni cikar (mevcut davranisla tutarli).
// Inverse trade'de volume degismedigi icin orijinal risk mesafesi baz alinir.
async function calculateRTargetRisk(analysisId, entryPrice, sl, tp) {
  if (analysisId == null) {
    return { rTarget: null, rRisk: 1 }; // MANUAL/analysis'siz order -> varsayilan
  }
  const { rows } = await pool.query(
    `SELECT entry, sl FROM btc_analysis WHERE id = $1`,
    [analysisId]
  );
  const a = rows[0];
  if (!a || a.entry == null || a.sl == null) {
    return { rTarget: null, rRisk: 1 };
  }
  const sizingRiskDistance = Math.abs(Number(a.entry) - Number(a.sl));
  if (sizingRiskDistance === 0) {
    return { rTarget: null, rRisk: 1 };
  }
  const rTarget = tp != null ? Number((Math.abs(tp - entryPrice) / sizingRiskDistance).toFixed(4)) : null;
  const rRisk = sl != null ? Number((Math.abs(sl - entryPrice) / sizingRiskDistance).toFixed(4)) : 1;
  return { rTarget, rRisk };
}

// LSR açı hesabı: (metric, period) -> orders kolonu.
const LSR_ANGLE_COMBOS = [
  ['global', '1h', 'h1LsAngle'], ['global', '5m', 'm5LsAngle'],
  ['top_position', '1h', 'h1TtPosAngle'], ['top_position', '5m', 'm5TtPosAngle'],
];

// Yeni order için 4 açı değerini hesaplar. Binance'e GİTMEZ -- hakari-lsr-refresher'ın
// 5 dakikada bir doldurduğu lsr_series tablosunu okur. Look-ahead-safe: yalnızca tMs
// anına kadar kapanmış pencerelerden (bkz. lsrAngle.js / lsr_order_report.py, aynı
// matematik). Lag=1: en son -henüz kapanmamış olabilecek- periyodu değil, kesin
// kapanmış son periyodu kullanır -- db/lsr_backfill.py ile AYNI kural, geçmiş ve yeni
// order'lar tutarlı hesaplanır.
//
// KRİTİK: herhangi bir hata (lsr_series henüz yoksa, DB sorunlarında, vb.) SESSİZCE
// 4 null'a düşer. Bu fonksiyon HİÇBİR ZAMAN throw etmemeli -- gerçek order insert'i
// açı hesabına bağımlı olmamalı.
async function computeLsrAngles(tMs) {
  const out = { h1LsAngle: null, m5LsAngle: null, h1TtPosAngle: null, m5TtPosAngle: null };
  for (const [metric, period, key] of LSR_ANGLE_COMBOS) {
    try {
      const { rows } = await pool.query(
        `SELECT open_time, long_short_ratio FROM lsr_series
         WHERE metric = $1 AND period = $2 AND open_time <= $3
         ORDER BY open_time ASC`,
        [metric, period, tMs]
      );
      if (rows.length < 30) continue; // pencere icin yetersiz veri -- referans_yetersiz ile ayni anlamda
      const series = new LsrSeries(rows.map(r => ({ t: Number(r.open_time), v: Number(r.long_short_ratio) })), period);
      const { result } = series.statsAt(tMs, 1);
      if (result) out[key] = Number(result.angle.toFixed(2));
    } catch (err) {
      console.error(`computeLsrAngles hatası (${metric}/${period}):`, err.message);
    }
  }
  return out;
}

// Acilarin hesaplandigi an: order'in MT5'te olustugu an (piyasa emrinde acilis deal'i, bekleyen
// emirde emrin verildigi an). Canli akista Date.now() ile ayni; yeniden baslatma / baglanti kopmasi
// sonrasi gecikmeli islenen order'da acinin isleme anina degil islem anina gore hesaplanmasini
// saglar. Gecersiz ya da ileri bir zamansa simdi.
// Istisna: monitor kapaliyken hem verilip hem dolan bekleyen emir burada yalnizca acilis deal'iyle
// gorulur; emrin verildigi an deal'de olmadigi icin dolum ani kullanilir. (hakari-dashboard mutabakati
// ayni durumda emrin verildigi ani MT5 emir gecmisinden alir.)
function angleTimeMs(t) {
  const now = Date.now();
  const ms = t instanceof Date ? t.getTime() : (t != null ? new Date(t).getTime() : NaN);
  return Number.isFinite(ms) && ms <= now ? ms : now;
}

// Insert a new order row (system or manual). Streaming tek yazma noktasi.
async function insertOrder(data) {
  const { rTarget, rRisk } = await calculateRTargetRisk(
    data.analysisId ?? null, data.entryPrice, data.sl, data.tp
  );
  const { h1LsAngle, m5LsAngle, h1TtPosAngle, m5TtPosAngle } = await computeLsrAngles(angleTimeMs(data.angleTime));
  const { rows } = await pool.query(
    `INSERT INTO orders
       (analysis_id, apify_run_id, mt5_order_id, mt5_position_id, magic, strategy_label, symbol, direction,
        volume, entry_price, fill_price, sl, tp, rr, r_target, r_risk, status, opened_at,
        h1_ls_angle, m5_ls_angle, h1_tt_pos_angle, m5_tt_pos_angle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      data.analysisId ?? null,
      data.apifyRunId ?? null,
      data.mt5OrderId,
      data.mt5PositionId ?? null,
      data.magic ?? 0,
      data.strategyLabel ?? 'MANUAL',
      data.symbol,
      data.direction,
      data.volume,
      data.entryPrice,
      data.fillPrice ?? null,
      data.sl,
      data.tp,
      calculateRR(data.entryPrice, data.sl, data.tp),
      rTarget,
      rRisk,
      data.status,
      data.openedAt ?? null,
      h1LsAngle,
      m5LsAngle,
      h1TtPosAngle,
      m5TtPosAngle,
    ]
  );
  return rows[0].id;
}
// -------------------- WEBHOOK NOTIFY --------------------
async function notifyMake(eventType, order, extra = {}) {
  try {
    await fetch(notifyWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventType,
        order_id: order.id,
        analysis_id: order.analysis_id,
        mt5_order_id: order.mt5_order_id,
        mt5_position_id: order.mt5_position_id,
        magic: order.magic,
        strategy_label: order.strategy_label,
        symbol: order.symbol,
        direction: order.direction,
        ...extra,
      }),
    });
  } catch (err) {
    console.error(`notifyMake hatası (${eventType}, order_id=${order.id}):`, err.message);
  }
}
// -------------------- MAIN --------------------
async function start() {
  const account = await api.metatraderAccountApi.getAccount(accountId);
  if (account.state !== 'DEPLOYED') {
    await account.deploy();
  }
  await account.waitConnected();
  const connection = account.getStreamingConnection();
  const listener = createSafeListener({
    async onDealAdded(instanceIndex, deal) {
      if (seenDeals.has(deal.id)) return;
      try {
        if (deal.entryType === 'DEAL_ENTRY_IN') {
          await handleDealIn(deal, connection);
        } else if (deal.entryType === 'DEAL_ENTRY_OUT' || deal.entryType === 'DEAL_ENTRY_OUT_BY') {
          await handleDealOut(deal, connection);
        }
        // SADECE basariyla islendiyse "gorulmus" sayilir -- hata olursa
        // (bu VARCHAR hatasi gibi, ya da herhangi baska GECICI bir sorun)
        // seenDeals'a HIC eklenmez, boylece MetaAPI ayni deal'i tekrar
        // gonderirse (resync sirasinda oldugu gibi) yeniden denenir.
        seenDeals.add(deal.id)
      } catch (err) {
        console.error(`onDealAdded islenirken hata (deal.id=${deal.id}, positionId=${deal.positionId}):`, err.message)
      }
    }
  });
  connection.addSynchronizationListener(listener);
  await connection.connect();
  console.log('🚀 Order monitor active');
  setInterval(() => pollOrders(connection), 1500);
  setInterval(() => pollPositions(connection), 1500);
  setInterval(() => expireOldPendingOrders(connection), 5 * 60 * 1000);
  setInterval(() => sweepOpenOrders(connection), SWEEP_MS);
}
// -------------------- DEAL HANDLERS --------------------
async function handleDealIn(deal, connection) {
  const existing = await getOrderByMt5Id(deal.orderId);
  if (existing) {
    if (existing.status !== 'PENDING') return;
    await pool.query(
      `UPDATE orders
         SET status='OPEN', mt5_position_id=$1, fill_price=$2, opened_at=$3, updated_at=now()
       WHERE id=$4`,
      [deal.positionId, deal.price, deal.time, existing.id]
    );
    await insertOrderEvent(existing.id, 'OPENED', { price: deal.price, rawPayload: deal, eventTime: deal.time });
    if (existing.strategy_label !== 'MANUAL' && !isPanelMagic(existing.magic)) {
      await notifyMake('OPENED', existing, {
        fill_price: deal.price,
        sl: existing.sl,
        tp: existing.tp,
        volume: existing.volume,
      });
    }
    return;
  }
  const position = connection.terminalState.positions.find(p => p.id === deal.positionId);
  const { isPanel, analysisId, apifyRunId, strategyLabel, isSystem } = await resolveOrigin(deal);
  const direction = deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';
  const id = await insertOrder({
    analysisId: isSystem ? analysisId : null,
    apifyRunId: isSystem ? apifyRunId : null,
    mt5OrderId: deal.orderId,
    mt5PositionId: deal.positionId,
    magic: deal.magic,
    strategyLabel: isSystem ? (strategyLabel ?? `MAGIC_${deal.magic}`) : 'MANUAL',
    symbol: deal.symbol,
    direction,
    volume: deal.volume,
    entryPrice: deal.price,
    fillPrice: deal.price,
    // Pozisyon terminalState'teyse onun guncel SL/TP'si (eski davranis); pozisyon henuz dusmediyse
    // acilis deal'inin tasidigi emir SL/TP'si. Ikisi de yoksa pollPositions (fillMissingSlTp) tamamlar.
    sl: position ? positiveOrNull(position.stopLoss) : positiveOrNull(deal.stopLoss),
    tp: position ? positiveOrNull(position.takeProfit) : positiveOrNull(deal.takeProfit),
    status: 'OPEN',
    openedAt: deal.time,
    angleTime: deal.time,
  });
  await insertOrderEvent(id, 'CREATED', { source: 'streaming', rawPayload: deal, eventTime: deal.time });
  await insertOrderEvent(id, 'OPENED', { price: deal.price, source: 'streaming', rawPayload: deal, eventTime: deal.time });
  if (isPanel) {
    console.log(`🖱 Panel emri: order=${id} pozisyon=${deal.positionId} etiket=${strategyLabel ?? 'MANUAL'} clientId=${deal.clientId ?? '-'}`);
  }
  // Panel emirleri Make'e bildirilmez (analiz/apify bagi yok).
  if (isSystem && !isPanel) {
    const order = await getOrderByMt5Id(deal.orderId);
    if (order) {
      await notifyMake('OPENED', order, { fill_price: deal.price, sl: order.sl, tp: order.tp, volume: order.volume });
    }
  }
}
// -------------------- KAPANIS: KISMI / TAM --------------------
// "Pozisyon tamamen kapandi mi?" sorusunun cevabi MT5'in KENDI deal gecmisinden gelir (MetaApi
// REST, pozisyona gore): kapanis deal'lerinin hacmi acilis hacmine ulastiysa kapanmistir.
// Eskiden bu karar yalnizca DB'ye yazilan PARTIAL_CLOSE kayitlarinin toplamiyla veriliyordu; bir
// kismi kapanis kaydi eksik kalinca (monitor kapali / baglanti koptu / yazarken hata) order hic
// kapanmiyor, ayni deal tekrar gelince (deploy sonrasi gecmis yeniden gelir) erken kapaniyordu.
// Simdi: MT5 gecmisi + DB'ye yazilmis kismi kapanislar + islenen deal, deal id'ye gore tekil
// birlestirilir. Her kaynak MT5'teki gercek deal'lerin bir alt kumesi oldugu icin birlesim cift
// saymaz; REST gecmisi eksik donse bile (gecikme / yukleniyor) DB'deki parcalar kaybolmaz.
// REST'e ulasilamazsa yalnizca DB kayitlari + islenen deal (order.volume'a karsi) kullanilir.
const VOLUME_EPS = 0.001; // lot hassasiyeti icin tolerans
const CLOSING_ENTRY_TYPES = new Set(['DEAL_ENTRY_OUT', 'DEAL_ENTRY_OUT_BY']);
const clientApiUrl = (process.env.METAAPI_CLIENT_API_URL || 'https://mt-client-api-v1.london.agiliumtrade.ai').replace(/\/+$/, '');
const REST_TIMEOUT_MS = 5_000; // REST cagrisi SDK'nin olay kuyrugunda calisiyor: uzun beklemesin
const REST_BACKOFF_MS = Number(process.env.METAAPI_REST_BACKOFF_MS ?? 60_000); // hatadan sonra bu sure REST denenmez
const GONE_RECHECK_MS = [10_000, 60_000, 5 * 60_000]; // pozisyon kayboldu ama gecmis henuz kapanisi gostermiyorsa
const SWEEP_MS = Number(process.env.OPEN_ORDER_SWEEP_MS) || 5 * 60_000; // DB'de acik / MT5'te yok taramasi
const SWEEP_MAX = 20; // bir taramada en fazla bu kadar pozisyonun gecmisine bakilir (MetaApi kredisi)
let restDownUntil = 0;

const timeMs = (t) => new Date(t).getTime();
const sumVolume = (deals) => deals.reduce((sum, d) => sum + Number(d.volume ?? 0), 0);

// Pozisyonun MT5'teki tum deal'leri. Hata olursa throw eder ve REST_BACKOFF_MS boyunca REST'i atlatir.
async function fetchPositionDeals(positionId) {
  if (Date.now() < restDownUntil) throw new Error('MetaApi REST az önce hata verdi, geçici olarak atlanıyor');
  try {
    const res = await fetch(
      `${clientApiUrl}/users/current/accounts/${accountId}/history-deals/position/${encodeURIComponent(positionId)}`,
      { headers: { 'auth-token': token, Accept: 'application/json' }, signal: AbortSignal.timeout(REST_TIMEOUT_MS) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const deals = await res.json();
    if (!Array.isArray(deals)) throw new Error('beklenmeyen yanıt');
    return deals;
  } catch (err) {
    restDownUntil = Date.now() + REST_BACKOFF_MS;
    throw err;
  }
}

// Deal listesinden kapanis durumu (deal id'ye gore tekil; ayni id'de sonraki kaynak oncekini ezer).
// extraDeal: henuz gecmise dusmemis olabilecek, su an islenen deal. Acilis deal'i yoksa acilis hacmi
// olarak order.volume kullanilir.
function closeStateFromDeals(deals, extraDeal, fallbackOpenVolume, source) {
  const byId = new Map();
  for (const d of deals) if (d && d.id != null) byId.set(String(d.id), d);
  if (extraDeal && extraDeal.id != null) byId.set(String(extraDeal.id), extraDeal);
  const all = [...byId.values()];
  const outs = all.filter((d) => CLOSING_ENTRY_TYPES.has(d.entryType)).sort((a, b) => timeMs(a.time) - timeMs(b.time));
  const inVolume = sumVolume(all.filter((d) => d.entryType === 'DEAL_ENTRY_IN'));
  const openVolume = inVolume > 0 ? inVolume : fallbackOpenVolume;
  const closedVolume = sumVolume(outs);
  return { outs, openVolume, closedVolume, closed: outs.length > 0 && closedVolume >= openVolume - VOLUME_EPS, source };
}

// DB'deki PARTIAL_CLOSE kayitlari, deal olarak. id: kaydin raw_payload'indaki deal id'si (yoksa sentetik).
async function recordedPartials(order) {
  const { rows } = await pool.query(
    `SELECT price, profit, new_value AS volume, event_time, raw_payload FROM order_events
      WHERE order_id = $1 AND event_type = 'PARTIAL_CLOSE' ORDER BY id`,
    [order.id]
  );
  return rows.map((r, i) => {
    const dealId = r.raw_payload?.id;
    return {
      id: dealId != null ? String(dealId) : `event-${i}`,
      realId: dealId != null,
      entryType: 'DEAL_ENTRY_OUT',
      price: Number(r.price),
      profit: Number(r.profit ?? 0),
      volume: Number(r.volume ?? 0),
      time: r.event_time,
      reason: r.raw_payload?.reason,
    };
  });
}

// Pozisyonun kapanis durumu (bkz. yukaridaki aciklama). deal: su an islenen deal ya da null.
async function mt5CloseState(order, deal) {
  const recorded = await recordedPartials(order);
  try {
    const deals = await fetchPositionDeals(order.mt5_position_id);
    // Kimligi olmayan (deal id'siz) eski kayitlar MT5 verisiyle eslestirilemez: REST varken sayilmaz.
    return closeStateFromDeals([...recorded.filter((d) => d.realId), ...deals], deal, Number(order.volume), 'mt5');
  } catch (err) {
    console.warn(`MT5 deal geçmişi alınamadı (pozisyon=${order.mt5_position_id}): ${err.message} -- DB'deki kısmi kapanışlarla karar veriliyor`);
    return closeStateFromDeals(recorded, deal, Number(order.volume), 'db');
  }
}

// Order'i TUM kapanis deal'lerinden kapatir: hacim-agirlikli ortalama fiyat, toplam kar, son deal'in
// zamani ve nedeni. Durum guncellemesi ve CLOSED olayi tek transaction'da; Make bildirimi commit'ten
// sonra. Atomik guard (WHERE status != 'CLOSED'): ayni anda iki yol (deal / kaybolan pozisyon /
// tarama) kapatmaya calisirsa yalnizca biri yazar. Kapattiysa true.
async function finalizeClose(order, state) {
  let totalPnl = 0, weightedPriceSum = 0, totalVolume = 0;
  for (const d of state.outs) {
    const v = Number(d.volume ?? 0);
    totalPnl += Number(d.profit ?? 0);
    weightedPriceSum += Number(d.price ?? 0) * v;
    totalVolume += v;
  }
  const lastOut = state.outs[state.outs.length - 1];
  const avgClosePrice = totalVolume > 0 ? weightedPriceSum / totalVolume : Number(lastOut.price);
  const { exitReason, isManual } = classifyClose(lastOut, order);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE orders
         SET status='CLOSED', close_price=$1, realized_pnl=$2, closed_at=$3,
             exit_reason=$4, is_manual=$5, updated_at=now()
       WHERE id=$6 AND status != 'CLOSED'`,
      [avgClosePrice, totalPnl, lastOut.time, exitReason, isManual, order.id]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await insertOrderEvent(order.id, 'CLOSED', {
      isManual,
      price: avgClosePrice,
      profit: totalPnl,
      rawPayload: lastOut,
      eventTime: lastOut.time,
    }, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log(`✔ Kapandı: order=${order.id} pozisyon=${order.mt5_position_id} parça=${state.outs.length} hacim=${totalVolume.toFixed(2)}/${state.openVolume} kar=${totalPnl.toFixed(2)} (${state.source})`);
  if (order.strategy_label !== 'MANUAL' && !isPanelMagic(order.magic)) {
    await notifyMake('CLOSED', order, {
      close_price: avgClosePrice,
      profit: totalPnl,
      exit_reason: exitReason,
      is_manual: isManual,
    });
  }
  return true;
}

async function handleDealOut(deal, connection) {
  const order = await getOrderByPositionId(deal.positionId);
  if (!order) {
    console.warn(`DEAL_ENTRY_OUT: order bulunamadı (positionId=${deal.positionId})`);
    return;
  }
  if (order.status === 'CLOSED') return;

  const state = await mt5CloseState(order, deal);
  if (state.closed) {
    await finalizeClose(order, state); // false: diger yol az once kapatti
    return;
  }

  // KISMI kapanis -- orders tablosuna DOKUNMA, olayi BIR KEZ kaydet (ayni deal tekrar gelirse yazma).
  const { rows: dup } = await pool.query(
    `SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'PARTIAL_CLOSE' AND raw_payload->>'id' = $2 LIMIT 1`,
    [order.id, String(deal.id)]
  );
  if (dup.length > 0) return;
  await insertOrderEvent(order.id, 'PARTIAL_CLOSE', {
    price: deal.price,
    profit: deal.profit ?? 0,
    newValue: deal.volume,  // bu parcada kapatilan hacim
    rawPayload: deal,
    eventTime: deal.time,
  });
  console.log(`↔ Kısmi kapanış: order=${order.id} pozisyon=${deal.positionId} hacim=${deal.volume} kar=${deal.profit} (kapanan=${state.closedVolume.toFixed(2)}/${state.openVolume}, ${state.source})`);
}

// Baglanti saglikli mi: yeniden baglanma / senkronizasyon sirasinda terminalState gecici olarak bos
// ya da eksik olabilir; o sirada "pozisyon kayboldu" sonucu cikarilmaz.
function connectionHealthy(connection) {
  return connection.synchronized !== false && connection.terminalState.connectedToBroker !== false;
}

// Pozisyon MT5'teki acik pozisyonlardan kayboldu: kapanis deal'i gelmemis ya da islenememis olsa da
// order'i MT5 gecmisinden kapatir. Gecmis henuz kapanisi gostermiyorsa birkac kez tekrar bakar.
// Pozisyon basina tek zincir; pozisyon geri gelirse (yeniden baglanma) iptal edilir ve onceki SL/TP
// durumu (prevPositions) korunur -- boylece aradaki SL/TP degisikligi MODIFIED olarak yakalanir.
const goneChecks = new Map(); // positionId -> true (calisiyor) | bekleyen tekrar zamanlayicisi

function startGoneCheck(positionId, connection) {
  if (goneChecks.has(positionId)) return;
  goneChecks.set(positionId, true);
  void runGoneCheck(positionId, connection, 0);
}

function cancelGoneCheck(positionId) {
  const handle = goneChecks.get(positionId);
  if (handle === undefined) return;
  if (handle !== true) clearTimeout(handle);
  goneChecks.delete(positionId);
}

async function runGoneCheck(positionId, connection, attempt) {
  if (!goneChecks.has(positionId)) return;
  goneChecks.set(positionId, true);
  let finished = false; // true: order kapandi ya da artik acik degil -- takip biter
  try {
    if (connection.terminalState.positions.some((p) => p.id === positionId)) {
      cancelGoneCheck(positionId); // geri geldi
      return;
    }
    const order = await getOrderByPositionId(positionId);
    if (!order || order.status !== 'OPEN') {
      finished = true;
    } else {
      const state = await mt5CloseState(order, null);
      if (state.closed) {
        if (await finalizeClose(order, state)) console.log(`🔎 Pozisyon MT5'te yok, kapanış geçmişten tamamlandı: order=${order.id}`);
        finished = true;
      }
    }
  } catch (err) {
    console.error(`kapanış kontrolü hatası (pozisyon=${positionId}):`, err.message);
  }
  if (!goneChecks.has(positionId)) return; // bu sirada iptal edildi (pozisyon geri geldi)
  if (!finished && attempt < GONE_RECHECK_MS.length) {
    const handle = setTimeout(() => runGoneCheck(positionId, connection, attempt + 1), GONE_RECHECK_MS[attempt]);
    handle.unref?.();
    goneChecks.set(positionId, handle);
    return;
  }
  if (!finished) {
    console.warn(`⚠ Pozisyon ${positionId} MT5'te açık değil ama geçmişi tam kapanış göstermiyor; ${GONE_RECHECK_MS.length + 1} denemeden sonra bırakıldı (periyodik tarama ve mutabakat yeniden bakar)`);
  }
  goneChecks.delete(positionId);
  prevPositions.delete(positionId);
}

// Periyodik guvenlik agi: DB'de ACIK olup MT5'te acik pozisyonu olmayan order'lar. Bu surec o
// pozisyonu hic gormemis olabilir (monitor kapaliyken kapandi, kapanis deal'i hic gelmedi).
// Karar yine MT5 gecmisinden; tek turda en fazla SWEEP_MAX pozisyon.
let sweepRunning = false;
async function sweepOpenOrders(connection) {
  if (sweepRunning || !connectionHealthy(connection)) return;
  sweepRunning = true;
  try {
    const openIds = new Set(connection.terminalState.positions.map((p) => String(p.id)));
    const { rows } = await pool.query(`SELECT * FROM orders WHERE status = 'OPEN' AND mt5_position_id IS NOT NULL ORDER BY id`);
    let checked = 0;
    for (const order of rows) {
      const positionId = String(order.mt5_position_id);
      if (openIds.has(positionId) || goneChecks.has(positionId)) continue;
      if (++checked > SWEEP_MAX) break;
      const state = await mt5CloseState(order, null);
      if (state.closed && (await finalizeClose(order, state))) {
        console.log(`🧹 Tarama: MT5'te kapanmış order kapatıldı: order=${order.id} pozisyon=${positionId}`);
      }
    }
  } catch (err) {
    console.error('sweepOpenOrders hatası:', err.message);
  } finally {
    sweepRunning = false;
  }
}
function classifyClose(deal, order) {
  const reason = deal.reason;
  if (reason === 'DEAL_REASON_SL') return { exitReason: 'SL', isManual: false };
  if (reason === 'DEAL_REASON_TP') return { exitReason: 'TP', isManual: false };
  const tolerance = priceTolerance(order.symbol, deal.price);
  const nearSl = order.sl != null && Math.abs(deal.price - order.sl) <= tolerance;
  const nearTp = order.tp != null && Math.abs(deal.price - order.tp) <= tolerance;
  if (nearTp) return { exitReason: 'TP', isManual: false };
  if (nearSl) return { exitReason: 'SL', isManual: false };
  const exitReason = (deal.profit ?? 0) >= 0 ? 'TP' : 'SL';
  return { exitReason, isManual: true };
}
function priceTolerance(symbol, price) {
  return price * 0.0005;
}
// -------------------- POLLING: ORDERS --------------------
async function pollOrders(connection) {
  const currentOrders = connection.terminalState.orders;
  const currentIds = new Set(currentOrders.map(o => o.id));
  for (const o of currentOrders) {
    const prev = prevOrders.get(o.id);
    if (!prev) {
      const existing = await getOrderByMt5Id(o.id);
      if (!existing) {
        const { analysisId, apifyRunId, strategyLabel, isSystem } = await resolveOrigin(o);
        const direction = o.type?.includes('SELL') ? 'SELL' : 'BUY'
        const id = await insertOrder({
          analysisId: isSystem ? analysisId : null,
          apifyRunId: isSystem ? apifyRunId : null,
          mt5OrderId: o.id,
          mt5PositionId: null,
          magic: o.magic,
          strategyLabel: isSystem ? (strategyLabel ?? `MAGIC_${o.magic}`) : 'MANUAL',
          symbol: o.symbol,
          direction,
          volume: o.volume,
          entryPrice: o.openPrice,
          fillPrice: null,
          sl: o.stopLoss,
          tp: o.takeProfit,
          status: 'PENDING',
          openedAt: null,
          angleTime: o.time, // emrin verildigi an
        });
        await insertOrderEvent(id, 'CREATED', { source: 'streaming', rawPayload: o });
      }
    } else if (
      prev.openPrice !== o.openPrice ||
      prev.stopLoss !== o.stopLoss ||
      prev.takeProfit !== o.takeProfit
    ) {
      const existing = await getOrderByMt5Id(o.id);
      if (existing) {
        const { rTarget, rRisk } = await calculateRTargetRisk(
          existing.analysis_id, o.openPrice, o.stopLoss, o.takeProfit
        );
        await pool.query(
          `UPDATE orders SET entry_price=$1, sl=$2, tp=$3, rr=$4, r_target=$5, r_risk=$6, updated_at=now() WHERE id=$7`,
          [o.openPrice, o.stopLoss, o.takeProfit, calculateRR(o.openPrice, o.stopLoss, o.takeProfit), rTarget, rRisk, existing.id]
        );
        if (prev.stopLoss !== o.stopLoss) {
          await insertOrderEvent(existing.id, 'MODIFIED', { isManual: true, oldValue: prev.stopLoss, newValue: o.stopLoss, rawPayload: o });
        }
        if (prev.takeProfit !== o.takeProfit) {
          await insertOrderEvent(existing.id, 'MODIFIED', { isManual: true, oldValue: prev.takeProfit, newValue: o.takeProfit, rawPayload: o });
        }
        if (prev.openPrice !== o.openPrice) {
          await insertOrderEvent(existing.id, 'MODIFIED', { isManual: true, oldValue: prev.openPrice, newValue: o.openPrice, rawPayload: o });
        }
      }
    }
    prevOrders.set(o.id, { openPrice: o.openPrice, stopLoss: o.stopLoss, takeProfit: o.takeProfit });
  }
  const openPositionIds = new Set(connection.terminalState.positions.map(p => String(p.id)));
  for (const id of [...prevOrders.keys()]) {
    if (currentIds.has(id)) continue;
    const existing = await getOrderByMt5Id(id);
    if (!existing || existing.status !== 'PENDING') {
      prevOrders.delete(id);
      continue;
    }
    {
      const hasPosition =
        openPositionIds.has(String(id)) ||
        (existing.mt5_position_id && openPositionIds.has(String(existing.mt5_position_id)));
      if (hasPosition) continue;
      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      if (ageMs < 3000) continue;
      await pool.query(
        `UPDATE orders SET status='CANCELED', exit_reason=NULL, is_manual=true, closed_at=now(), updated_at=now() WHERE id=$1`,
        [existing.id]
      );
      await insertOrderEvent(existing.id, 'CANCELED', { isManual: true });
    }
    prevOrders.delete(id);
  }
}
// -------------------- POLLING: POSITIONS --------------------
// Pozisyon ILK kez goruldugunde (panel, strateji ya da elle acilmis -- hepsi): order SL/TP'siz
// kaydedildiyse pozisyondaki degerlerle tamamlanir. pollPositions SL/TP degisikligini onceki halle
// kiyaslayarak yakalar; ilk goruste kiyaslanacak onceki hal yoktur. Bu yuzden SL/TP o ana kadar
// girilmisse burasi yakalar:
//   - deal islenirken pozisyon henuz terminalState'te yoktu / SL-TP'siz idi ve SL/TP hemen ardindan
//     eklendi (orn. MT5'ten elle acilan islemler)
//   - monitor yeniden baslarken acik olan pozisyonlar (kapaliyken girilen SL/TP)
// Yalnizca BOS alanlar doldurulur (dolu alan dropdown'la duzeltilmis olabilir) ve degisiklik
// sayilmaz -- MODIFIED olayi yazilmaz, Make'e bildirilmez.
async function fillMissingSlTp(p) {
  const posSl = positiveOrNull(p.stopLoss);
  const posTp = positiveOrNull(p.takeProfit);
  if (posSl == null && posTp == null) return;
  try {
    const existing = await getOrderByPositionId(p.id);
    if (!existing || existing.status !== 'OPEN') return;
    if (existing.sl != null && existing.tp != null) return;
    const sl = existing.sl != null ? Number(existing.sl) : posSl;
    const tp = existing.tp != null ? Number(existing.tp) : posTp;
    const entry = Number(existing.fill_price ?? existing.entry_price);
    const { rTarget, rRisk } = await calculateRTargetRisk(existing.analysis_id, entry, sl, tp);
    // COALESCE: okuma ile yazma arasinda elle girilen deger ezilmesin
    const { rowCount } = await pool.query(
      `UPDATE orders SET sl=COALESCE(sl, $1), tp=COALESCE(tp, $2), rr=$3, r_target=$4, r_risk=$5, updated_at=now()
        WHERE id=$6 AND (sl IS NULL OR tp IS NULL)`,
      [sl, tp, calculateRR(entry, sl, tp), rTarget, rRisk, existing.id]
    );
    if (rowCount > 0) console.log(`✎ SL/TP tamamlandı: order=${existing.id} pozisyon=${p.id} SL=${sl} TP=${tp}`);
  } catch (err) {
    console.error(`fillMissingSlTp hatası (pozisyon=${p.id}):`, err.message);
  }
}
let pollPositionsRunning = false;
async function pollPositions(connection) {
  if (pollPositionsRunning) return; // onceki tur (DB yazimlari) bitmeden yenisi baslamasin
  pollPositionsRunning = true;
  try {
    const positions = connection.terminalState.positions;
    for (const p of positions) {
      cancelGoneCheck(p.id); // (yeniden) gorundu
      const prev = prevPositions.get(p.id);
      if (!prev) {
        await fillMissingSlTp(p);
      }
      if (prev && (prev.stopLoss !== p.stopLoss || prev.takeProfit !== p.takeProfit)) {
        const existing = await getOrderByPositionId(p.id);
        if (existing) {
          const { rTarget, rRisk } = await calculateRTargetRisk(
            existing.analysis_id, existing.fill_price, p.stopLoss, p.takeProfit
          );
          await pool.query(
            `UPDATE orders SET sl=$1, tp=$2, rr=$3, r_target=$4, r_risk=$5, updated_at=now() WHERE id=$6`,
            [p.stopLoss, p.takeProfit, calculateRR(existing.fill_price, p.stopLoss, p.takeProfit), rTarget, rRisk, existing.id]
          );
          if (prev.stopLoss !== p.stopLoss) {
            await insertOrderEvent(existing.id, 'MODIFIED', { isManual: true, oldValue: prev.stopLoss, newValue: p.stopLoss, rawPayload: p });
          }
          if (prev.takeProfit !== p.takeProfit) {
            await insertOrderEvent(existing.id, 'MODIFIED', { isManual: true, oldValue: prev.takeProfit, newValue: p.takeProfit, rawPayload: p });
          }
        }
      }
      prevPositions.set(p.id, { stopLoss: p.stopLoss, takeProfit: p.takeProfit });
    }
    // Onceki turlarda gorulup artik olmayan pozisyonlar: kapanis deal'i gelmese de order kapansin.
    // Baglanti saglikli degilse bekle (terminalState gecici bos olabilir).
    if (connectionHealthy(connection)) {
      const currentIds = new Set(positions.map((p) => p.id));
      for (const id of prevPositions.keys()) {
        if (!currentIds.has(id)) startGoneCheck(id, connection);
      }
    }
  } catch (err) {
    console.error('pollPositions hatası:', err.message);
  } finally {
    pollPositionsRunning = false;
  }
}
// -------------------- EXPIRY POLLER --------------------
async function expireOldPendingOrders(connection) {
  const { rows } = await pool.query(
    `SELECT id, mt5_order_id, analysis_id, magic, strategy_label, symbol, direction
     FROM orders
     WHERE status='PENDING' AND strategy_label != 'MANUAL'
       AND created_at < now() - interval '${expiryHours} hours'`
  );

  for (const row of rows) {
    try {
      await connection.cancelOrder(row.mt5_order_id);
    } catch (err) {
      console.error(`ORDER_CANCEL hatası (id=${row.mt5_order_id}):`, err.message);
      continue; // order kapanmadıysa DB'yi güncelleme
    }

    await pool.query(
      `UPDATE orders SET status='CANCELED', exit_reason='EXPIRED', is_manual=false, closed_at=now(), updated_at=now() WHERE id=$1`,
      [row.id]
    );
    await insertOrderEvent(row.id, 'CANCELED', { isManual: false, source: 'poller_expiry' });
    await notifyMake('EXPIRED', row, { exit_reason: 'EXPIRED' });
  }
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

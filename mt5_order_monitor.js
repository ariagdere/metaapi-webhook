const MetaApi = require('metaapi.cloud-sdk').default;
const { Pool } = require('pg');
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
  7575: 'NAIF + ZLEME',
};
function resolveStrategyLabel(magic) {
  return STRATEGY_MAP[Number(magic)] || null;
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
async function insertOrderEvent(orderId, eventType, opts = {}) {
  await pool.query(
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

// Insert a new order row (system or manual). Streaming tek yazma noktasi.
async function insertOrder(data) {
  const { rTarget, rRisk } = await calculateRTargetRisk(
    data.analysisId ?? null, data.entryPrice, data.sl, data.tp
  );
  const { rows } = await pool.query(
    `INSERT INTO orders
       (analysis_id, apify_run_id, mt5_order_id, mt5_position_id, magic, strategy_label, symbol, direction,
        volume, entry_price, fill_price, sl, tp, rr, r_target, r_risk, status, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
      seenDeals.add(deal.id);
      if (deal.entryType === 'DEAL_ENTRY_IN') {
        await handleDealIn(deal, connection);
      } else if (deal.entryType === 'DEAL_ENTRY_OUT') {
        await handleDealOut(deal, connection);
      }
    }
  });
  connection.addSynchronizationListener(listener);
  await connection.connect();
  console.log('🚀 Order monitor active');
  setInterval(() => pollOrders(connection), 1500);
  setInterval(() => pollPositions(connection), 1500);
  setInterval(() => expireOldPendingOrders(connection), 5 * 60 * 1000);
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
    if (existing.strategy_label !== 'MANUAL') {
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
  const { analysisId, apifyRunId } = parseCommentField(deal.comment ?? deal.brokerComment);
  const strategyLabel = resolveStrategyLabel(deal.magic);
  const isSystem = analysisId != null || apifyRunId != null || strategyLabel != null;
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
    sl: position?.stopLoss ?? null,
    tp: position?.takeProfit ?? null,
    status: 'OPEN',
    openedAt: deal.time,
  });
  await insertOrderEvent(id, 'CREATED', { source: 'streaming', rawPayload: deal, eventTime: deal.time });
  await insertOrderEvent(id, 'OPENED', { price: deal.price, source: 'streaming', rawPayload: deal, eventTime: deal.time });
  if (isSystem) {
    const order = await getOrderByMt5Id(deal.orderId);
    if (order) {
      await notifyMake('OPENED', order, { fill_price: deal.price, sl: order.sl, tp: order.tp, volume: order.volume });
    }
  }
}
async function handleDealOut(deal, connection) {
  const order = await getOrderByPositionId(deal.positionId);
  if (!order) {
    console.warn(`DEAL_ENTRY_OUT: order bulunamadı (positionId=${deal.positionId})`);
    return;
  }
  if (order.status === 'CLOSED') return;

  // Bu order icin simdiye kadar KAYDEDILMIS tum kismi kapanislari cek --
  // hem "bu deal FINAL mi" sorusunu cevaplamak, hem (final ise) hacim-
  // agirlikli ortalama fiyat/kar hesabinda kullanmak icin.
  const { rows: partials } = await pool.query(
    `SELECT price, profit, new_value AS volume FROM order_events
       WHERE order_id = $1 AND event_type = 'PARTIAL_CLOSE'`,
    [order.id]
  );
  const previouslyClosedVolume = partials.reduce((sum, p) => sum + Number(p.volume ?? 0), 0);
  const dealVolume = Number(deal.volume ?? 0);
  const originalVolume = Number(order.volume);
  const VOLUME_EPS = 0.001; // lot hassasiyeti icin tolerans

  // ONEMLI: "bu deal kismi mi final mi" sorusunu connection.terminalState'in
  // O ANKI durumuna bakarak DEGIL, SADECE veritabanindaki gecmis kayitlara
  // ve bu deal'in KENDI hacmine bakarak cevapliyoruz. Streaming baglantisi
  // kopup yeniden baglanirsa, MetaAPI gecikmeli/backlog deal'leri GERIYE
  // DONUK teslim edebilir -- o an terminalState ZATEN pozisyonun SONRAKI
  // (belki tamamen kapanmis) halini gosteriyor olabilir, bu da ESKI
  // (aslinda kismi olan) bir deal'i YANLISLIKLA "final" sandirir. Hacim
  // toplami, ISLEME SIRASINDAN VE terminalState'in ANLIK durumundan
  // TAMAMEN BAGIMSIZ, deterministik bir sinyal.
  const isFinalClose = (previouslyClosedVolume + dealVolume) >= (originalVolume - VOLUME_EPS);

  if (!isFinalClose) {
    // KISMI kapanis -- orders tablosuna DOKUNMA, sadece olayi kaydet.
    await insertOrderEvent(order.id, 'PARTIAL_CLOSE', {
      price: deal.price,
      profit: deal.profit ?? 0,
      newValue: deal.volume,  // bu parcada kapatilan hacim
      rawPayload: deal,
      eventTime: deal.time,
    });
    console.log(`↔ Kısmi kapanış: order=${order.id} pozisyon=${deal.positionId} hacim=${deal.volume} kar=${deal.profit} (toplam kapanan=${(previouslyClosedVolume + dealVolume).toFixed(4)}/${originalVolume})`);
    return;
  }

  // GERCEK final kapanis -- bu order'a ait TUM kismi kapanislari + bu son
  // deal'i toplayip, hacim-agirlikli ortalama fiyat ve toplam kar hesapla.
  let totalPnl = deal.profit ?? 0;
  let weightedPriceSum = deal.price * dealVolume;
  let totalVolume = dealVolume;
  for (const p of partials) {
    totalPnl += Number(p.profit ?? 0);
    weightedPriceSum += Number(p.price) * Number(p.volume ?? 0);
    totalVolume += Number(p.volume ?? 0);
  }
  const avgClosePrice = totalVolume > 0 ? weightedPriceSum / totalVolume : deal.price;

  const { exitReason, isManual } = classifyClose(deal, order);
  // Atomik guard: WHERE status != 'CLOSED' ile, ayni order icin PARALEL
  // calisan iki final-kapanis islemenin (teorik olarak) ikisinin de
  // guncelleme yapmasini engeller -- sadece ilki basarili olur.
  const { rowCount } = await pool.query(
    `UPDATE orders
       SET status='CLOSED', close_price=$1, realized_pnl=$2, closed_at=$3,
           exit_reason=$4, is_manual=$5, updated_at=now()
     WHERE id=$6 AND status != 'CLOSED'`,
    [avgClosePrice, totalPnl, deal.time, exitReason, isManual, order.id]
  );
  if (rowCount === 0) {
    console.warn(`handleDealOut: order=${order.id} zaten kapanmis (yaris durumu engellendi)`);
    return;
  }
  await insertOrderEvent(order.id, 'CLOSED', {
    isManual,
    price: avgClosePrice,
    profit: totalPnl,
    rawPayload: deal,
    eventTime: deal.time,
  });
  if (order.strategy_label !== 'MANUAL') {
    await notifyMake('CLOSED', order, {
      close_price: avgClosePrice,
      profit: totalPnl,
      exit_reason: exitReason,
      is_manual: isManual,
    });
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
        const { analysisId, apifyRunId } = parseCommentField(o.comment ?? o.brokerComment);
        const strategyLabel = resolveStrategyLabel(o.magic);
        const isSystem = analysisId != null || apifyRunId != null || strategyLabel != null;
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
async function pollPositions(connection) {
  const positions = connection.terminalState.positions;
  for (const p of positions) {
    const prev = prevPositions.get(p.id);
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

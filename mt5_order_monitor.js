const MetaApi = require('metaapi.cloud-sdk').default;
const { Pool } = require('pg');
const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const databaseUrl = process.env.DATABASE_URL;
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
};
function resolveStrategyLabel(magic) {
  return STRATEGY_MAP[Number(magic)] || null;
}
function parseAnalysisId(comment) {
  if (comment == null) return null;
  const s = String(comment).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
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
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
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
       (analysis_id, mt5_order_id, mt5_position_id, magic, strategy_label, symbol, direction,
        volume, entry_price, fill_price, sl, tp, rr, r_target, r_risk, status, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      data.analysisId ?? null,
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
        await handleDealOut(deal);
      }
    }
  });
  connection.addSynchronizationListener(listener);
  await connection.connect();
  console.log('🚀 Order monitor active');
  setInterval(() => pollOrders(connection), 1500);
  setInterval(() => pollPositions(connection), 1500);
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
    await insertOrderEvent(existing.id, 'OPENED', { price: deal.price, rawPayload: deal });
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
  const analysisId = parseAnalysisId(deal.comment ?? deal.brokerComment);
  const strategyLabel = resolveStrategyLabel(deal.magic);
  const isSystem = analysisId != null || strategyLabel != null;
  const direction = deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';
  const id = await insertOrder({
    analysisId: isSystem ? analysisId : null,
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
  await insertOrderEvent(id, 'CREATED', { source: 'streaming', rawPayload: deal });
  await insertOrderEvent(id, 'OPENED', { price: deal.price, source: 'streaming', rawPayload: deal });
  if (isSystem) {
    const order = await getOrderByMt5Id(deal.orderId);
    if (order) {
      await notifyMake('OPENED', order, { fill_price: deal.price, sl: order.sl, tp: order.tp, volume: order.volume });
    }
  }
}
async function handleDealOut(deal) {
  const order = await getOrderByPositionId(deal.positionId);
  if (!order) {
    console.warn(`DEAL_ENTRY_OUT: order bulunamadı (positionId=${deal.positionId})`);
    return;
  }
  if (order.status === 'CLOSED') return;
  const { exitReason, isManual } = classifyClose(deal, order);
  await pool.query(
    `UPDATE orders
       SET status='CLOSED', close_price=$1, realized_pnl=$2, closed_at=$3,
           exit_reason=$4, is_manual=$5, updated_at=now()
     WHERE id=$6`,
    [deal.price, deal.profit ?? 0, deal.time, exitReason, isManual, order.id]
  );
  await insertOrderEvent(order.id, 'CLOSED', {
    isManual,
    price: deal.price,
    profit: deal.profit ?? 0,
    rawPayload: deal,
  });
  if (order.strategy_label !== 'MANUAL') {
    await notifyMake('CLOSED', order, {
      close_price: deal.price,
      profit: deal.profit ?? 0,
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
        const analysisId = parseAnalysisId(o.comment ?? o.brokerComment);
        const strategyLabel = resolveStrategyLabel(o.magic);
        const isSystem = analysisId != null || strategyLabel != null;
        const direction = o.type?.includes('SELL') ? 'SELL' : 'BUY';
        const id = await insertOrder({
          analysisId: isSystem ? analysisId : null,
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
start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

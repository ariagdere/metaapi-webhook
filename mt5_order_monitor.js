const MetaApi = require('metaapi.cloud-sdk').default;
const { Pool } = require('pg');

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const databaseUrl = process.env.DATABASE_URL;
const expiryHours = parseInt(process.env.PENDING_EXPIRY_HOURS || '8', 10);
const notifyWebhookUrl = process.env.NOTIFY_WEBHOOK_URL || 'https://hook.eu2.make.com/nc9p8mvzsn46mqolimwfpktp9yqpzt28';

const api = new MetaApi(token, { region: 'london' });
const pool = new Pool({ connectionString: databaseUrl });

const startTime = new Date();
const seenDeals = new Set();
const prevOrders = new Map();
const prevPositions = new Map();

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

// Insert a row for activity Make didn't create (manual order / manual position)
async function insertManualOrder(data) {
  const { rows } = await pool.query(
    `INSERT INTO orders
       (mt5_order_id, mt5_position_id, magic, strategy_label, symbol, direction,
        volume, entry_price, fill_price, sl, tp, rr, status, opened_at)
     VALUES ($1,$2,$3,'MANUAL',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      data.mt5OrderId,
      data.mt5PositionId,
      data.magic ?? 0,
      data.symbol,
      data.direction,
      data.volume,
      data.entryPrice,
      data.fillPrice,
      data.sl,
      data.tp,
      calculateRR(data.entryPrice, data.sl, data.tp),
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
        event: eventType, // 'OPENED' | 'CLOSED' | 'EXPIRED'
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
      if (new Date(deal.time) < startTime) return;
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

  // 1-2 sn polling: orders + positions
  setInterval(() => pollOrders(connection), 1500);
  setInterval(() => pollPositions(connection), 1500);

  // expiry poller
  setInterval(() => expireOldPendingOrders(connection), 5 * 60 * 1000);
}

// -------------------- DEAL HANDLERS --------------------

async function handleDealIn(deal, connection) {
  const existing = await getOrderByMt5Id(deal.orderId);

  if (existing) {
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

  // Eşleşme yok -> manuel market order
  const position = connection.terminalState.positions.find(p => p.id === deal.positionId);
  const direction = deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';
  const id = await insertManualOrder({
    mt5OrderId: deal.orderId,
    mt5PositionId: deal.positionId,
    magic: deal.magic,
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
}

async function handleDealOut(deal) {
  const order = await getOrderByPositionId(deal.positionId);
  if (!order) {
    console.warn(`DEAL_ENTRY_OUT: order bulunamadı (positionId=${deal.positionId})`);
    return;
  }

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

// deal.reason güvenilir değilse fiyat-tolerans fallback kullanılır
function classifyClose(deal, order) {
  const reason = deal.reason;

  if (reason === 'DEAL_REASON_SL') return { exitReason: 'SL', isManual: false };
  if (reason === 'DEAL_REASON_TP') return { exitReason: 'TP', isManual: false };

  // Fallback: kapanış fiyatı SL/TP'ye yakınsa otomatik say
  const tolerance = priceTolerance(order.symbol, deal.price);
  const nearSl = order.sl != null && Math.abs(deal.price - order.sl) <= tolerance;
  const nearTp = order.tp != null && Math.abs(deal.price - order.tp) <= tolerance;

  if (nearTp) return { exitReason: 'TP', isManual: false };
  if (nearSl) return { exitReason: 'SL', isManual: false };

  // Ne SL ne TP'ye yakın -> manuel kapama; kâr/zarara göre etiketle
  const exitReason = (deal.profit ?? 0) >= 0 ? 'TP' : 'SL';
  return { exitReason, isManual: true };
}

function priceTolerance(symbol, price) {
  // BTCUSD için ~ %0.05; gerekirse sembole göre genişletilir
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
        // Make tarafından insert edilmemiş -> manuel pending order
        const direction = o.type?.includes('SELL') ? 'SELL' : 'BUY';
        const id = await insertManualOrder({
          mt5OrderId: o.id,
          mt5PositionId: null,
          magic: o.magic,
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
        await pool.query(
          `UPDATE orders SET entry_price=$1, sl=$2, tp=$3, rr=$4, updated_at=now() WHERE id=$5`,
          [o.openPrice, o.stopLoss, o.takeProfit, calculateRR(o.openPrice, o.stopLoss, o.takeProfit), existing.id]
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

  // Kaybolan order'lar -> manuel iptal AMA fill olduysa (position'a dondu) dokunma
  const openPositionIds = new Set(connection.terminalState.positions.map(p => String(p.id)));
  for (const id of [...prevOrders.keys()]) {
    if (currentIds.has(id)) continue;

    // Order listeden kalkti. Iki olasilik:
    // 1) fill oldu -> ayni id'li bir position var, ya da DB'de zaten OPEN/CLOSED
    // 2) gercekten iptal edildi -> position yok ve DB hala PENDING
    const existing = await getOrderByMt5Id(id);

    // DB'de artik PENDING degilse (OPEN/CLOSED olmus) takipten dusur, dokunma
    if (!existing || existing.status !== 'PENDING') {
      prevOrders.delete(id);
      continue;
    }

    {
      const hasPosition =
        openPositionIds.has(String(id)) ||
        (existing.mt5_position_id && openPositionIds.has(String(existing.mt5_position_id)));

      if (hasPosition) {
        // Fill olmus, onDealAdded birazdan OPEN yapacak -> iptal etme
        continue;
      }

      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      if (ageMs < 3000) continue; // fill deal gecikmesine tolerans

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
        await pool.query(
          `UPDATE orders SET sl=$1, tp=$2, rr=$3, updated_at=now() WHERE id=$4`,
          [p.stopLoss, p.takeProfit, calculateRR(existing.fill_price, p.stopLoss, p.takeProfit), existing.id]
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
    await insertOrderEvent(row.id, 'CANCELED', { isManual: false, source: 'poller_8h_expiry' });
    await notifyMake('EXPIRED', row, { exit_reason: 'EXPIRED' });
  }
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

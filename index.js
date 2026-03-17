const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

const api = new MetaApi(token, { region: 'london' });

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

async function start() {
  const account = await api.metatraderAccountApi.getAccount(accountId);

  if (account.state !== 'DEPLOYED') {
    await account.deploy();
  }

  await account.waitConnected();

  const connection = account.getStreamingConnection();

  // DEAL (zaten vardı)
  const listener = createSafeListener({
    async onDealAdded(instanceIndex, deal) {

      if (new Date(deal.time) < startTime) return;
      if (seenDeals.has(deal.id)) return;
      seenDeals.add(deal.id);

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'DEAL',
          event: deal.entryType === 'DEAL_ENTRY_IN' ? 'OPEN' : 'CLOSE',
          symbol: deal.symbol,
          positionId: deal.positionId,
          orderId: deal.orderId,
          price: deal.price,
          volume: deal.volume,
          profit: deal.profit || 0,
          time: deal.time
        })
      });
    }
  });

  connection.addSynchronizationListener(listener);
  await connection.connect();

  console.log('🚀 ALL EVENTS ACTIVE');

  // 🔥 ORDER + POSITION TRACKING
  setInterval(async () => {

    const orders = connection.terminalState.orders;
    const positions = connection.terminalState.positions;

    // ---- ORDER ----
    const currentOrderIds = new Set();

    for (const o of orders) {
      currentOrderIds.add(o.id);

      const prev = prevOrders.get(o.id);

      if (!prev) {
        // NEW
        await send('ORDER', 'CREATED', o);
      } else if (JSON.stringify(prev) !== JSON.stringify(o)) {
        // UPDATED
        await send('ORDER', 'UPDATED', o);
      }

      prevOrders.set(o.id, o);
    }

    // REMOVED
    for (const [id, prev] of prevOrders) {
      if (!currentOrderIds.has(id)) {
        await send('ORDER', 'REMOVED', prev);
        prevOrders.delete(id);
      }
    }

    // ---- POSITION ----
    const currentPositionIds = new Set();

    for (const p of positions) {
      currentPositionIds.add(p.id);

      const prev = prevPositions.get(p.id);

      if (!prev) {
        await send('POSITION', 'OPENED', p);
      } else if (JSON.stringify(prev) !== JSON.stringify(p)) {
        await send('POSITION', 'UPDATED', p);
      }

      prevPositions.set(p.id, p);
    }

    // CLOSED
    for (const [id, prev] of prevPositions) {
      if (!currentPositionIds.has(id)) {
        await send('POSITION', 'CLOSED', prev);
        prevPositions.delete(id);
      }
    }

  }, 1000);
}

async function send(type, event, data) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      event,
      id: data.id,
      symbol: data.symbol,
      volume: data.volume,
      price: data.openPrice || data.price,
      sl: data.stopLoss,
      tp: data.takeProfit,
      profit: data.profit,
      time: data.time
    })
  });
}

start();
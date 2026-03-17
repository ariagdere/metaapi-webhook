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

  // ✅ DEAL (tek gerçek execution)
  const listener = createSafeListener({
    async onDealAdded(instanceIndex, deal) {

      if (new Date(deal.time) < startTime) return;
      if (seenDeals.has(deal.id)) return;
      seenDeals.add(deal.id);

      await send({
        type: 'DEAL',
        event: deal.entryType === 'DEAL_ENTRY_IN' ? 'OPEN' : 'CLOSE',
        symbol: deal.symbol,
        positionId: deal.positionId,
        orderId: deal.orderId,
        price: deal.price,
        volume: deal.volume,
        profit: deal.profit || 0,
        time: deal.time
      });
    }
  });

  connection.addSynchronizationListener(listener);
  await connection.connect();

  console.log('🚀 CLEAN MODE ACTIVE');

  setInterval(async () => {

    const orders = connection.terminalState.orders;
    const positions = connection.terminalState.positions;

    // ---- ORDER ----
    for (const o of orders) {
      const prev = prevOrders.get(o.id);

      if (!prev) {
        // CREATED
        await send({
          type: 'ORDER',
          event: 'CREATED',
          id: o.id,
          symbol: o.symbol,
          volume: o.volume,
          price: o.openPrice,
          sl: o.stopLoss,
          tp: o.takeProfit,
          time: o.time
        });
      } else if (JSON.stringify(prev) !== JSON.stringify(o)) {
        // UPDATED
        await send({
          type: 'ORDER',
          event: 'UPDATED',
          id: o.id,
          symbol: o.symbol,
          volume: o.volume,
          price: o.openPrice,
          sl: o.stopLoss,
          tp: o.takeProfit,
          time: o.time
        });
      }

      prevOrders.set(o.id, o);
    }

    // ---- POSITION ----
    for (const p of positions) {
      const prev = prevPositions.get(p.id);

      if (prev && JSON.stringify(prev) !== JSON.stringify(p)) {
        // sadece UPDATE (OPEN/CLOSE yok)
        await send({
          type: 'POSITION',
          event: 'UPDATED',
          id: p.id,
          symbol: p.symbol,
          volume: p.volume,
          price: p.openPrice,
          sl: p.stopLoss,
          tp: p.takeProfit,
          profit: p.profit,
          time: p.time
        });
      }

      prevPositions.set(p.id, p);
    }

  }, 1000);
}

async function send(payload) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

start();
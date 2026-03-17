const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

const api = new MetaApi(token, { region: 'london' });

// sadece yeni event'ler
const startTime = new Date();

// duplicate engelle
const seenDeals = new Set();
const seenOrders = new Set();

// crash engelle
function createSafeListener(handler) {
  return new Proxy(handler, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => {};
    }
  });
}

async function start() {
  console.log('Başlatılıyor...');

  const account = await api.metatraderAccountApi.getAccount(accountId);

  if (account.state !== 'DEPLOYED') {
    await account.deploy();
  }

  await account.waitConnected();
  console.log('MT5 connected');

  const connection = account.getStreamingConnection();

  const listener = createSafeListener({

    // ✅ DEAL (gerçekleşmiş işlem)
    async onDealAdded(instanceIndex, deal) {

      if (new Date(deal.time) < startTime) return;
      if (seenDeals.has(deal.id)) return;
      seenDeals.add(deal.id);

      const payload = {
        type: 'DEAL',
        event: deal.entryType === 'DEAL_ENTRY_IN' ? 'OPEN' : 'CLOSE',
        symbol: deal.symbol,
        direction: deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL',
        price: deal.price,
        volume: deal.volume,
        profit: deal.profit || 0,
        dealId: deal.id,
        orderId: deal.orderId,
        positionId: deal.positionId,
        time: deal.time
      };

      console.log('DEAL:', payload);

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },

    // ✅ ORDER (pending emir)
    async onOrderUpdated(instanceIndex, order) {

      if (!order.time) return;
      if (new Date(order.time) < startTime) return;
      if (seenOrders.has(order.id)) return;
      seenOrders.add(order.id);

      // sadece yeni eklenen order
      if (order.state !== 'ORDER_STATE_PLACED') return;

      const payload = {
        type: 'ORDER',
        event: 'PLACED',
        symbol: order.symbol,
        orderType: order.type,
        volume: order.volume,
        price: order.openPrice,
        orderId: order.id,
        time: order.time
      };

      console.log('ORDER:', payload);

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

  });

  connection.addSynchronizationListener(listener);

  await connection.connect();

  console.log('🚀 Hazır. DEAL + ORDER dinleniyor...');
}

start();
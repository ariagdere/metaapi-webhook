const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

const api = new MetaApi(token, { region: 'london' });

const startTime = new Date();
const seenDeals = new Set();

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

  const listener = createSafeListener({
    async onDealAdded(instanceIndex, deal) {

      // 🔥 geçmişi ele
      if (new Date(deal.time) < startTime) return;

      // 🔥 duplicate engelle
      if (seenDeals.has(deal.id)) return;
      seenDeals.add(deal.id);

      const payload = {
        event: deal.entryType === 'DEAL_ENTRY_IN' ? 'OPEN' : 'CLOSE',
        symbol: deal.symbol,
        direction: deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL',
        price: deal.price,
        volume: deal.volume,
        profit: deal.profit || 0,
        dealId: deal.id,
        positionId: deal.positionId,
        time: deal.time
      };

      console.log('Yeni deal:', payload);

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  });

  connection.addSynchronizationListener(listener);

  await connection.connect();

  console.log('🚀 Hazır. Duplicate yok.');
}

start();
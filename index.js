const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

const api = new MetaApi(token, { region: 'london' });

// 🔥 eksik listener methodlarını otomatik handle eder
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
    async onDealAdded(instanceIndex, deal) {
      try {
        const entryType =
          deal.entryType === 'DEAL_ENTRY_IN' ? 'OPEN' : 'CLOSE';

        const direction =
          deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';

        const payload = {
          event: entryType,
          symbol: deal.symbol,
          direction,
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

      } catch (err) {
        console.error('Webhook error:', err.message);
      }
    }
  });

  connection.addSynchronizationListener(listener);

  await connection.connect();

  console.log('🚀 Hazır. Trade bekleniyor...');
}

start();
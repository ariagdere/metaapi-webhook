const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

const api = new MetaApi(token, { region: 'london' });

let connection = null;
let isReady = false;

async function initConnection() {
  if (connection) return connection;

  console.log('MetaAPI bağlanıyor...');

  const account = await api.metatraderAccountApi.getAccount(accountId);

  if (account.state !== 'DEPLOYED') {
    await account.deploy();
  }

  await account.waitConnected();
  console.log('MT5 hesabına bağlandı');

  connection = account.getStreamingConnection();

  connection.addSynchronizationListener({
    async onSynchronized() {
      console.log('Senkronizasyon tamamlandı');
      isReady = true;
    },

    async onDealAdded(instanceIndex, deal) {
      if (!isReady) return;

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

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        console.log('Webhook gönderildi:', response.status);

      } catch (err) {
        console.error('Webhook hatası:', err.message);
      }
    },

    // 🔥 TÜM GEREKLİ BOŞ METHODLAR (ARTIK HATA YOK)
    async onConnected() {},
    async onDisconnected() {},
    async onBrokerConnectionStatusChanged() {},

    async onAccountInformationUpdated() {},
    async onPositionsReplaced() {},
    async onPositionUpdated() {},
    async onPositionRemoved() {},

    async onOrdersReplaced() {},
    async onOrderUpdated() {},
    async onOrderCompleted() {},

    async onHistoryOrderAdded() {},
    async onDealAdded() {}, // zaten yukarıda var ama safe

    async onSymbolSpecificationUpdated() {},
    async onSymbolSpecificationRemoved() {},
    async onSymbolPriceUpdated() {},

    async onCandlesUpdated() {},
    async onTicksUpdated() {},
    async onBooksUpdated() {},

    async onSubscriptionDowngraded() {},
    async onStreamClosed() {},
    async onHealthStatus() {}
  });

  await connection.connect();
  await connection.waitSynchronized();

  return connection;
}

async function start() {
  while (true) {
    try {
      await initConnection();

      await new Promise(resolve => setTimeout(resolve, 60000));

    } catch (err) {
      console.error('Hata:', err.message);

      connection = null;
      isReady = false;

      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

start();
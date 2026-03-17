const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

async function run() {
  console.log('MetaAPI Webhook Listener başlatılıyor...');
  
  const api = new MetaApi(token);
  
  const account = await api.metatraderAccountApi.getAccount(accountId);
  
  if (account.state !== 'DEPLOYED') {
    await account.deploy();
  }
  
  await account.waitConnected();
  console.log('MT5 hesabına bağlandı');

  const connection = account.getRPCConnection();
  await connection.connect();
  await connection.waitSynchronized();
  console.log('Senkronizasyon tamamlandı, trade dinleniyor...');

  connection.addSynchronizationListener({
    async onDealAdded(instanceIndex, deal) {
      try {
        const entryType = deal.entryType === 'DEAL_ENTRY_IN' ? 'OPEN' : 'CLOSE';
        const direction = deal.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';

        const payload = {
          event: entryType,
          symbol: deal.symbol,
          direction: direction,
          price: deal.price,
          volume: deal.volume,
          profit: deal.profit || 0,
          ticket: deal.id,
          time: deal.time
        };

        console.log('Deal tespit edildi:', payload);

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        console.log('Webhook gönderildi, status:', response.status);
      } catch (err) {
        console.error('Webhook hatası:', err.message);
      }
    }
  });
}

// Bağlantı kopunca yeniden bağlan
async function startWithRetry() {
  while (true) {
    try {
      await run();
    } catch (err) {
      console.error('Hata, 10 saniye sonra yeniden bağlanılacak:', err.message);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

startWithRetry();

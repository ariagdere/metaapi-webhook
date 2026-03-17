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

  const connection = account.getStreamingConnection();

  let synchronized = false;
  const startTime = new Date();

  // Proxy ile tüm metodları yakala — SDK hangi metodu çağırırsa çağırsın hata vermez
  const listener = new Proxy({
    async onSynchronized() {
      synchronized = true;
      console.log('Senkronizasyon tamamlandı, trade dinleniyor...');
    },

    async onDealAdded(instanceIndex, deal) {
      if (!synchronized) return;

      const dealTime = new Date(deal.time);
      if (dealTime < startTime) return;

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

        console.log('Yeni deal tespit edildi:', payload);

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
  }, {
    get(target, prop) {
      return prop in target ? target[prop] : () => {};
    }
  });

  connection.addSynchronizationListener(listener);

  await connection.connect();
  await connection.waitSynchronized();

  await new Promise(() => {});
}

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

const MetaApi = require('metaapi.cloud-sdk').default;
const { SynchronizationListener } = require('metaapi.cloud-sdk');

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const webhookUrl = process.env.WEBHOOK_URL;

class TradeListener extends SynchronizationListener {
  constructor() {
    super();
    this.synchronized = false;
    this.startTime = new Date();
  }

  async onSynchronized() {
    this.synchronized = true;
    console.log('Senkronizasyon tamamlandı, trade dinleniyor...');
  }

  async onConnected() {
    console.log('Bağlantı kuruldu');
  }

  async onDisconnected() {
    console.log('Bağlantı koptu');
  }

  async onDealAdded(instanceIndex, deal) {
    if (!this.synchronized) return;

    const dealTime = new Date(deal.time);
    if (dealTime < this.startTime) return;

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

      console.log('Yeni deal tespit edildi:', JSON.stringify(payload));

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
}

async function run() {
  console.log('MetaAPI Webhook Listener başlatılıyor...');

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);
  console.log('Hesap durumu:', account.state);

  if (account.state !== 'DEPLOYED') {
    console.log('Hesap deploy ediliyor...');
    await account.deploy();
  }

  await account.waitConnected();
  console.log('MT5 hesabına bağlandı');

  const connection = account.getStreamingConnection();
  const listener = new TradeListener();
  connection.addSynchronizationListener(listener);

  console.log('Streaming bağlantısı kuruluyor...');
  await connection.connect();
  
  console.log('Senkronizasyon bekleniyor...');
  await connection.waitSynchronized({ timeoutInSeconds: 60 });

  console.log('Hazır, trade dinleniyor...');
  await new Promise(() => {});
}

async function startWithRetry() {
  while (true) {
    try {
      await run();
    } catch (err) {
      console.error('Hata:', err.message, '— 10 saniye sonra yeniden bağlanılacak');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

startWithRetry();

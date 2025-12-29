const { Client, GatewayIntentBits, Partials } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// ===== 可調設定 =====
const CHECK_INTERVAL_HOURS = 24;
// ===================

let lastCheckin = Date.now();
let awaitingResponse = false;
let contactsAgreed = new Set();
let notified = false;

client.once('ready', () => {
  console.log(`ALIVE bot logged in as ${client.user.tag}`);
});

async function checkAlive() {
  const diffHours = (Date.now() - lastCheckin) / 36e5;
  if (diffHours >= CHECK_INTERVAL_HOURS && !awaitingResponse) {
    awaitingResponse = true;
    notified = false;

    const owner = await client.users.fetch(process.env.OWNER_ID);
    await owner.send('ALIVE check-in.\n\nPlease confirm when available.');
  }
}

async function notifyAllContacts() {
  if (notified) return;
  notified = true;

  for (const id of contactsAgreed) {
    const user = await client.users.fetch(id);
    await user.send(
      'ALIVE notice.\n\nA scheduled check-in was not confirmed.\nThis is not an emergency alert.\n\nReply "RECEIVED" to acknowledge.'
    );
  }
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const text = msg.content.trim().toUpperCase();

  // 使用者本人
  if (msg.author.id === process.env.OWNER_ID) {
    if (awaitingResponse) {
      awaitingResponse = false;
      lastCheckin = Date.now();
      await msg.reply('Check-in recorded.');
    }
    return;
  }

  // 聯絡人同意流程
  if (text === 'AGREE') {
    contactsAgreed.add(msg.author.id);
    await msg.reply('You are now an ALIVE contact.');
    return;
  }

  // 聯絡人收到
  if (text === 'RECEIVED') {
    awaitingResponse = false;
    await msg.reply('Acknowledged. No further action required.');
  }
});

setInterval(() => {
  if (awaitingResponse) notifyAllContacts();
}, 10 * 60 * 1000);

client.login(process.env.BOT_TOKEN);



const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const puppeteer = require("puppeteer");

let client;
let ready = false;
let initializing = false;
let reconnectTimer;
let lastQr;

function initWhatsAppClient() {
  if (client || initializing) return client;

  initializing = true;
  const authDataPath = process.env.WWEBJS_AUTH_PATH;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  client = new Client({
    authStrategy: authDataPath ? new LocalAuth({ dataPath: authDataPath }) : new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr) => {
    ready = false;
    lastQr = qr;
    console.log("\n[WhatsApp] QR received. Scan this once from WhatsApp:");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    ready = true;
    initializing = false;
    console.log("[WhatsApp] Client is ready and connected.");
  });

  client.on("authenticated", () => {
    console.log("[WhatsApp] Authenticated successfully.");
  });

  client.on("auth_failure", (msg) => {
    ready = false;
    initializing = false;
    console.error(`[WhatsApp] Authentication failure: ${msg}`);
  });

  client.on("disconnected", (reason) => {
    ready = false;
    console.warn(`[WhatsApp] Disconnected: ${reason}`);
    scheduleReconnect();
  });

  client.on("change_state", (state) => {
    console.log(`[WhatsApp] State changed: ${state}`);
  });

  client
    .initialize()
    .then(() => {
      initializing = false;
      console.log("[WhatsApp] Initialization started.");
    })
    .catch((error) => {
      initializing = false;
      ready = false;
      console.error("[WhatsApp] Initialization error:", error.message);
      scheduleReconnect();
    });

  return client;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      if (client) {
        await client.destroy();
      }
    } catch (error) {
      console.error("[WhatsApp] Error while destroying client:", error.message);
    } finally {
      client = null;
      ready = false;
      initializing = false;
      console.log("[WhatsApp] Attempting to reconnect...");
      initWhatsAppClient();
    }
  }, 5000);
}

async function sendOTP(phone, otp) {
  if (!client || !ready) {
    throw new Error("WhatsApp client is not ready");
  }

  const chatId = `${phone}@c.us`;
  const message =
    `🔐 *Yanforge Verification*\n` +
    `Your OTP is: *${otp}*\n` +
    `⏱ Valid for 5 minutes.\n` +
    `🚫 Do not share with anyone.`;

  await client.sendMessage(chatId, message);
}

function isReady() {
  return ready;
}

function getLatestQr() {
  return lastQr;
}

module.exports = {
  initWhatsAppClient,
  sendOTP,
  isReady,
  getLatestQr,
};

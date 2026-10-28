const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");

const app = express();

// x-showroom-id आणि इतर सर्व ब्राउझर हेडर्सना परवानगी देणारा सुधारित कोड
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, x-auth-token, x-showroom-id"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

let sock = null;
let qrCodeData = null;
let isConnected = false;
let isConnecting = false;

async function startWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      browser: ["Vihaan Automation", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        isConnected = false;
      }

      if (connection === "open") {
        isConnected = true;
        qrCodeData = null;
        isConnecting = false;
        console.log("WhatsApp Connected Successfully!");
      }

      if (connection === "close") {
        isConnected = false;
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          setTimeout(startWhatsApp, 3000);
        } else {
          qrCodeData = null;
          if (fs.existsSync("./auth_info")) {
            fs.rmSync("./auth_info", { recursive: true, force: true });
          }
          setTimeout(startWhatsApp, 2000);
        }
      }
    });
  } catch (err) {
    console.error("WhatsApp Error:", err);
    isConnecting = false;
  }
}

startWhatsApp();

function getStatusResponse() {
  return {
    success: true,
    status: isConnected ? "connected" : qrCodeData ? "qr" : "disconnected",
    connected: isConnected,
    isConnected: isConnected,
    qr: qrCodeData,
    qrCode: qrCodeData,
  };
}

// 1. होम आणि हेल्थ रूट्स
app.get("/", (req, res) => res.send("WhatsApp Gateway Server is Live!"));
app.get("/health", (req, res) => res.json(getStatusResponse()));

// 2. स्टेटस रूट्स
app.get("/session/status", (req, res) => res.json(getStatusResponse()));
app.get("/session/status/:id", (req, res) => res.json(getStatusResponse()));
app.get("/status", (req, res) => res.json(getStatusResponse()));
app.get("/status/:id", (req, res) => res.json(getStatusResponse()));

// 3. कनेक्ट आणि QR रूट्स
const handleConnect = async (req, res) => {
  if (!isConnected && !qrCodeData) {
    await startWhatsApp();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  res.json(getStatusResponse());
};

app.all("/session/connect", handleConnect);
app.all("/session/connect/:id", handleConnect);
app.all("/connect", handleConnect);
app.all("/connect/:id", handleConnect);

// 4. डिस्कनेक्ट रूट्स
const handleDisconnect = async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch (e) {}
  isConnected = false;
  qrCodeData = null;
  if (fs.existsSync("./auth_info")) {
    fs.rmSync("./auth_info", { recursive: true, force: true });
  }
  startWhatsApp();
  res.json({ success: true, status: "disconnected", connected: false });
};

app.all("/session/disconnect", handleDisconnect);
app.all("/session/disconnect/:id", handleDisconnect);

// 5. मेसेज पाठवण्याचे रूट्स
const handleSendMessage = async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(400).json({ success: false, error: "WhatsApp not connected" });
    }
    const { phone, number, to, message, text } = req.body;
    const rawNumber = phone || number || to;
    const msgText = message || text;

    let cleanNumber = String(rawNumber).replace(/\D/g, "");
    if (cleanNumber.length === 10) cleanNumber = "91" + cleanNumber;
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: msgText });
    res.json({ success: true, message: "Message sent" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.post("/send-message", handleSendMessage);
app.post("/session/send", handleSendMessage);
app.post("/session/send/:id", handleSendMessage);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WhatsApp Gateway Server listening on port ${PORT}`);
});

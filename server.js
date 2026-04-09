const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config({ override: true });

const authRoutes = require("./routes/auth");
const { initWhatsAppClient } = require("./services/whatsapp");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// In production, restrict CORS to your web app origin if you set CORS_ORIGIN.
// Example: CORS_ORIGIN=https://yourdomain.com
app.use(
  cors(
    process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : undefined,
  ),
);
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Yanforge WhatsApp OTP Auth API is running",
  });
});

app.use("/api/auth", authRoutes);

async function startServer() {
  try {
    console.log("[Server] Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("[Server] MongoDB connected successfully.");

    console.log("[Server] Initializing WhatsApp client...");
    initWhatsAppClient();
    console.log("[Server] WhatsApp initialization triggered.");

    app.listen(PORT, () => {
      console.log(`[Server] Express server running on port ${PORT}.`);
      console.log("[Server] API base: /api/auth");
    });
  } catch (error) {
    console.error("[Server] Failed to start server:", error.message);

    process.exit(1);
  }
}

startServer();

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const Otp = require("../models/Otp");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const { sendOTP, isReady } = require("../services/whatsapp");

// Supabase JWT secret — copy from Supabase Dashboard → Settings → API → JWT Secret
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

// Mint a JWT that Supabase accepts as an authenticated session.
// RLS policies use auth.jwt()->>'phone' which maps to the phone claim here.
function mintSupabaseToken(user) {
  if (!SUPABASE_JWT_SECRET) {
    console.warn('[Auth] SUPABASE_JWT_SECRET not set — skipping Supabase token');
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: user.supabaseUuid,        // maps to owners.id in Supabase
      role: 'authenticated',          // REQUIRED by Supabase
      aud: 'authenticated',           // REQUIRED by Supabase
      phone: '+92' + user.phone,      // used by RLS get_user_store_ids()
      iat: now,
      exp: now + 60 * 60 * 24 * 7,   // 7 days
    },
    SUPABASE_JWT_SECRET
  );
}

const router = express.Router();

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const MAX_SEND_PER_10_MINUTES = 3;
const MAX_VERIFY_ATTEMPTS = 5;

// Keep only local 10-digit part from client input.
function normalizePakistaniPhone(rawPhone) {
  const digitsOnly = String(rawPhone || "").replace(/\D/g, "");
  return digitsOnly;
}

function isValidPakistaniPhone(phone) {
  return /^\d{10}$/.test(phone);
}

function secureSixDigitOtp() {
  const otpInt = crypto.randomInt(100000, 1000000);
  return String(otpInt);
}

router.post("/send-otp", async (req, res) => {
  try {
    const phone = normalizePakistaniPhone(req.body.phone);

    if (!isValidPakistaniPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number. Enter 10 digits after +92.",
      });
    }

    if (!isReady()) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp service is not ready. Please try again shortly.",
      });
    }

    // Rate limit per phone using OTP creation history.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const sentCount = await Otp.countDocuments({
      phone,
      createdAt: { $gte: tenMinutesAgo },
    });

    if (sentCount >= MAX_SEND_PER_10_MINUTES) {
      return res.status(429).json({
        success: false,
        message: "Too many OTP requests. Try again after 10 minutes.",
      });
    }

    // Invalidate previous active OTPs before issuing a new one.
    await Otp.deleteMany({ phone, verified: false });

    const otp = secureSixDigitOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Otp.create({
      phone,
      otp,
      expiresAt,
      verified: false,
      attempts: 0,
    });

    // Send to WhatsApp in international format: 92XXXXXXXXXX
    await sendOTP(`92${phone}`, otp);

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully on WhatsApp.",
    });
  } catch (error) {
    console.error("[Auth][send-otp] Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP. Please try again.",
    });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const phone = normalizePakistaniPhone(req.body.phone);
    const otpInput = String(req.body.otp || "").trim();

    if (!isValidPakistaniPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number. Enter 10 digits after +92.",
      });
    }

    if (!/^\d{6}$/.test(otpInput)) {
      return res.status(400).json({
        success: false,
        message: "OTP must be exactly 6 digits.",
      });
    }

    // Always verify against the latest active OTP.
    const otpDoc = await Otp.findOne({
      phone,
      verified: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!otpDoc) {
      return res.status(400).json({
        success: false,
        message: "OTP expired or not found. Request a new OTP.",
      });
    }

    if (otpDoc.otp !== otpInput) {
      // Track wrong attempts and invalidate after max attempts.
      otpDoc.attempts += 1;

      if (otpDoc.attempts >= MAX_VERIFY_ATTEMPTS) {
        await Otp.deleteOne({ _id: otpDoc._id });
        return res.status(400).json({
          success: false,
          message: "Too many wrong attempts. OTP deleted. Request again.",
          attemptsRemaining: 0,
        });
      }

      await otpDoc.save();
      const attemptsRemaining = MAX_VERIFY_ATTEMPTS - otpDoc.attempts;
      return res.status(400).json({
        success: false,
        message: `Wrong OTP. ${attemptsRemaining} attempts remaining.`,
        attemptsRemaining,
      });
    }

    otpDoc.verified = true;
    await otpDoc.save();

    let user = await User.findOneAndUpdate(
      { phone },
      {
        $set: { verified: true },
        $setOnInsert: {
          createdAt: new Date(),
          supabaseUuid: uuidv4(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!user.supabaseUuid) {
      user.supabaseUuid = uuidv4();
      await user.save();
    }

    // Create Yanforge auth token after successful verification.
    const token = jwt.sign(
      { userId: user._id.toString(), phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    // Mint Supabase-compatible JWT for direct use with Supabase SDK
    const supabase_token = mintSupabaseToken(user);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      token,
      supabase_token,
      user: {
        id: user._id,
        phone: user.phone,
        supabaseUuid: user.supabaseUuid,
        verified: user.verified,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error("[Auth][verify-otp] Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to verify OTP. Please try again.",
    });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-__v");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user profile",
    });
  }
});

// ─────────────────────────────────────────
// Refresh Supabase token using Yanforge JWT
// Called by SyncWorker when Supabase token expires
// ─────────────────────────────────────────
router.post("/refresh-supabase-token", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!user.supabaseUuid) {
      user.supabaseUuid = uuidv4();
      await user.save();
    }

    const supabase_token = mintSupabaseToken(user);
    if (!supabase_token) {
      return res.status(500).json({
        success: false,
        message: "Supabase JWT secret not configured on server.",
      });
    }

    return res.status(200).json({
      success: true,
      supabase_token,
    });
  } catch (error) {
    console.error("[Auth][refresh-supabase-token] Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to refresh Supabase token.",
    });
  }
});

module.exports = router;

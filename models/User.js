const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // UUID used as `sub` claim in Supabase JWT — maps to owners.id in Supabase
    supabaseUuid: {
      type: String,
      required: true,
      unique: true,
      default: uuidv4,
    },
    verified: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);

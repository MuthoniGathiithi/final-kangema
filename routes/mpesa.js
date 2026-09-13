const express = require("express");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const {
  c2bValidation,
  c2bConfirmation,
  stkCallback,
  triggerStkPush,
  registerUrls,
  simulateC2B,
} = require("../controllers/mpesaController");

// --- Daraja calls these directly - no API key, Safaricom won't send one ---
router.post("/c2b/validation", c2bValidation);
router.post("/c2b/confirmation", c2bConfirmation);
router.post("/stk/callback", stkCallback);

// --- Your own app calls these - protected ---
router.post("/stk/push", requireApiKey, triggerStkPush);
router.post("/register-urls", requireApiKey, registerUrls);
router.post("/c2b/simulate", requireApiKey, simulateC2B);

module.exports = router;
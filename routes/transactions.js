const express = require("express");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const {
  listTransactions,
  getTransaction,
  createManualTransaction,
  exportTransactions,
  getTransactionStats,
  getTotalAmount,
} = require("../controllers/transactionsController");

router.use(requireApiKey);

router.get("/", listTransactions);
router.get("/stats", getTransactionStats);
router.get("/export", exportTransactions);
router.get("/:id", getTransaction);
router.post("/manual", createManualTransaction);
router.post("/sms", createManualTransaction); // SMS endpoint - same logic as manual but ensures source is set to sms

module.exports = router;

const express = require("express");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const { getTotalAmount } = require("../controllers/transactionsController");

router.use(requireApiKey);

router.get("/total-amount", getTotalAmount);

module.exports = router;

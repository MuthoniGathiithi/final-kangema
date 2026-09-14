const express = require("express");
const multer = require("multer");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const { importExcel, getExcelData } = require("../controllers/excelImportController");

// Keep the file in memory (no disk writes) - works on Vercel's read-only filesystem too
const upload = multer({ storage: multer.memoryStorage() });

router.post("/import", requireApiKey, upload.single("file"), importExcel);
router.get("/data", requireApiKey, getExcelData);

module.exports = router;

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const {
  importExcel,
  getExcelData,
  listExcelImports,
  listExcelSheets,
  deleteExcelImport,
  deleteExcelSheet,
  debugExcel,
} = require("../controllers/excelImportController");

// Keep the file in memory (no disk writes) - works on Vercel's read-only filesystem too
const upload = multer({ storage: multer.memoryStorage() });

router.post("/import", requireApiKey, upload.single("file"), importExcel);
router.get("/data", requireApiKey, getExcelData);
router.get("/imports", requireApiKey, listExcelImports);
router.get("/sheets", requireApiKey, listExcelSheets);
router.delete("/import/:id", requireApiKey, deleteExcelImport);
router.delete("/sheets/:sheetName", requireApiKey, deleteExcelSheet);
router.post("/debug", requireApiKey, upload.single("file"), debugExcel);

module.exports = router;

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const { importExcel, getExcelData, getStudents, getStudentsBySheet, getStudentById, listExcelSheets, deleteExcelSheet, deleteExcelImport, debugExcel } = require("../controllers/excelImportController");

// Keep the file in memory (no disk writes) - works on Vercel's read-only filesystem too
const upload = multer({ storage: multer.memoryStorage() });

router.post("/import", requireApiKey, upload.single("file"), importExcel);
router.get("/data", requireApiKey, getExcelData);
router.get("/students", requireApiKey, getStudents);
router.get("/students/:id", requireApiKey, getStudentById);
router.get("/sheets", requireApiKey, listExcelSheets);
router.get("/sheets/:sheetName/students", requireApiKey, getStudentsBySheet);
router.delete("/sheets/:sheetName", requireApiKey, deleteExcelSheet);
router.delete("/import/:id", requireApiKey, deleteExcelImport);
router.post("/debug", requireApiKey, upload.single("file"), debugExcel);

module.exports = router;

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { requireApiKey } = require("../middleware/auth");
const { importStudents, listStudents } = require("../controllers/studentsImportController");

const upload = multer({ storage: multer.memoryStorage() });

router.use(requireApiKey);

router.post("/import", upload.single("file"), importStudents);
router.get("/", listStudents);

module.exports = router;

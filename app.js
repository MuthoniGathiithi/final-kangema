require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const transactionsRoutes = require("./routes/transactions");
const mpesaRoutes = require("./routes/mpesa");
const excelImportRoutes = require("./routes/excelImport");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Backend-mpesa is running",
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "ok" });
});

// TEMPORARY - remove once we've confirmed env vars are correct on the live deployment
app.get("/api/debug-env", (req, res) => {
  const key = process.env.MPESA_CONSUMER_KEY || "";
  res.json({
    MPESA_ENV: process.env.MPESA_ENV || "(not set -> defaults to sandbox)",
    MPESA_SHORTCODE: process.env.MPESA_SHORTCODE || "(not set)",
    MPESA_CONSUMER_KEY_preview: key ? key.slice(0, 4) + "..." : "(not set)",
    BASE_URL_used: (process.env.MPESA_ENV || "sandbox") === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke",
    BASE_URL: process.env.BASE_URL || "(not set)",
    MPESA_CONFIRMATION_URL: process.env.MPESA_CONFIRMATION_URL || "(not set)",
    MPESA_VALIDATION_URL: process.env.MPESA_VALIDATION_URL || "(not set)",
    full_ConfirmationURL: `${process.env.BASE_URL || ""}${process.env.MPESA_CONFIRMATION_URL || ""}`,
    full_ValidationURL: `${process.env.BASE_URL || ""}${process.env.MPESA_VALIDATION_URL || ""}`,
  });
});

app.use("/api/transactions", transactionsRoutes);
app.use("/api/daraja", mpesaRoutes);
app.use("/api/excel", excelImportRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: `No route for ${req.method} ${req.originalUrl}` });
});

app.use(errorHandler);

module.exports = app;
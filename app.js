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

// Health check - useful to confirm the server (local or hosted) is actually up
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

app.use("/api/transactions", transactionsRoutes);
app.use("/api/mpesa", mpesaRoutes);
app.use("/api/excel", excelImportRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `No route for ${req.method} ${req.originalUrl}` });
});

app.use(errorHandler);

module.exports = app;

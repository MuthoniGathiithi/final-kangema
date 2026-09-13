// Vercel serverless entry point.
// Vercel routes all requests into this single function (see vercel.json),
// which just hands them to the same Express app used for local dev.
const app = require("../app");

module.exports = app;

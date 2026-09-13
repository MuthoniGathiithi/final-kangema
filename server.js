const app = require("./app");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`\nBackend-mpesa listening on http://localhost:${PORT}`);
  console.log(`Health check:        http://localhost:${PORT}/api/health`);
  console.log(`Transactions:        http://localhost:${PORT}/api/transactions`);
  console.log(`\nRemember: Daraja callbacks need a PUBLIC https URL.`);
  console.log(`Use "ngrok http ${PORT}" locally and update BASE_URL in .env, then`);
  console.log(`POST /api/mpesa/register-urls to tell Safaricom about it.\n`);
});

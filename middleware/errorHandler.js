function errorHandler(err, req, res, next) {
  console.error("[error]", err);

  // Axios errors from calling Daraja carry the real reason in err.response.data -
  // log and surface that instead of the generic "Request failed with status code 400"
  if (err.response) {
    console.error("[error] upstream response data:", JSON.stringify(err.response.data));
  }

  const status = err.statusCode || 500;
  const message = err.message || "Internal server error";

  res.status(status).json({
    success: false,
    message,
    upstreamError: err.response?.data || undefined,
  });
}

module.exports = errorHandler;
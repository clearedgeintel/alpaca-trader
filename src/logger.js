function log(message, data = null) {
  const ts = new Date().toISOString();
  const line = data
    ? `[${ts}] ${message} ${JSON.stringify(data)}`
    : `[${ts}] ${message}`;
  console.log(line);
}

function error(message, err) {
  console.error(`[${new Date().toISOString()}] ❌ ${message}`, err?.message || err);
}

module.exports = { log, error };

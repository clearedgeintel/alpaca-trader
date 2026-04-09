const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, data, error: err }) => {
          const parts = [`[${timestamp}] ${level}: ${message}`];
          if (data) parts.push(JSON.stringify(data));
          if (err) parts.push(err);
          return parts.join(' ');
        })
      ),
    }),
  ],
});

function log(message, data = null) {
  logger.info(message, data ? { data } : {});
}

function warn(message, data = null) {
  logger.warn(message, data ? { data } : {});
}

function error(message, err) {
  logger.error(message, { error: err?.message || err });
}

async function alert(message) {
  logger.error(`ALERT: ${message}`);

  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat = process.env.TELEGRAM_CHAT_ID;

  try {
    if (slackUrl) {
      await fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `[Alpaca Trader] ${message}` }),
      });
    }

    if (telegramToken && telegramChat) {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramChat, text: `[Alpaca Trader] ${message}` }),
      });
    }
  } catch (err) {
    logger.error('Failed to send alert notification', { error: err?.message || err });
  }
}

module.exports = { log, warn, error, alert };

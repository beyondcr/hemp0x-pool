function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

function installConsoleTimestamps({ clock = () => new Date() } = {}) {
  if (console.__hemp0xTimestamped) return;

  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(`[${formatTimestamp(clock())}]`, ...args);
    };
  }

  Object.defineProperty(console, '__hemp0xTimestamped', {
    value: true,
    enumerable: false,
    configurable: false,
  });
}

module.exports = {
  formatTimestamp,
  installConsoleTimestamps,
};

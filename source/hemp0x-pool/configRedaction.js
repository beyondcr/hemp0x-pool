/**
 * Config redaction helpers.
 *
 * Ensure sensitive config values are never leaked in:
 *   - log messages
 *   - API responses
 *   - documentation / markdown exports
 *   - error messages returned to clients
 */

const SECRET_KEY_PATTERNS = [
  /^daemon\.(user|pass)$/,
  /^daemon\.cookiePath$/,
  /cookiePath$/i,
  /pass(word)?$/i,
  /token$/i,
  /secret$/i,
  /key$/i,
  /auth$/i,
  /credential/i,
];

const REDACTED = '***REDACTED***';

function isSecretLike(key) {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Deep-clone a config object and return a version where secret-like values
 * are replaced with "***REDACTED***". Handles nested objects.
 *
 * @param {object} config - The configuration object (may be frozen).
 * @returns {object} A new plain object with secret values redacted.
 */
function redactSecrets(config) {
  if (config === null || config === undefined) return config;
  if (Array.isArray(config)) {
    return config.map((item) => redactSecrets(item));
  }
  if (typeof config !== 'object') return config;

  const result = {};
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactNestedSection(key, value);
    } else if (isSecretLike(key)) {
      result[key] = REDACTED;
    } else if (Array.isArray(value)) {
      result[key] = redactSecrets(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function redactNestedSection(sectionKey, section) {
  if (!section || typeof section !== 'object') return section;
  const result = {};
  for (const key of Object.keys(section)) {
    const fullPath = `${sectionKey}.${key}`;
    const value = section[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactNestedSection(fullPath, value);
    } else if (isSecretLike(key) || isSecretLike(fullPath)) {
      result[key] = REDACTED;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Sanitize an error message intended for public clients.
 * Strips RPC credentials, stack traces, file paths, and other internal details.
 *
 * @param {Error|string} err
 * @returns {string} Sanitized error message.
 */
function sanitizeError(err) {
  if (!err) return 'An internal error occurred';
  const msg = typeof err === 'string' ? err : err.message || String(err);

  let sanitized = msg;

  sanitized = sanitized.replace(/\/[^\s]*\/(\w+\.(js|json|sql|conf))/g, '[path]/$1');
  sanitized = sanitized.replace(/\/(?:home|Users|var|etc|opt|srv|tmp)\/[^\s]+/g, '[path]');
  sanitized = sanitized.replace(/RPC_USER|RPC_PASS|RPC_\w+/gi, '[credential]');
  sanitized = sanitized.replace(/Authorization:\s*Basic\s+[^\r\n]*/gi, 'Authorization: Basic ***');

  if (sanitized.includes('at ') && sanitized.includes('.js:')) {
    sanitized = sanitized.split('\n')[0];
  }

  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 500) + '...';
  }

  return sanitized;
}

/**
 * Apply a limit to a query parameter (e.g., ?limit=200). Defaults to max 100.
 * @param {*} value - The raw parameter value.
 * @param {number} [defaultVal=20]
 * @param {number} [maxVal=100]
 * @returns {number} Clamped integer.
 */
function clampLimit(value, defaultVal = 20, maxVal = 100) {
  if (value === undefined || value === null || value === '') return defaultVal;
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1) return defaultVal;
  return Math.min(num, maxVal);
}

module.exports = {
  REDACTED,
  isSecretLike,
  redactSecrets,
  redactNestedSection,
  sanitizeError,
  clampLimit,
};

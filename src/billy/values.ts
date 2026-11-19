/**
 * Value rules shared by tool schemas, handlers and the change resolution.
 *
 * Billy record ids are opaque strings chosen by Billy. The API documentation
 * shows ids such as `inv-1234` and `f0f111m0gayd9p4kk41s2f0a`; currencies and
 * countries are referred to by their ISO codes (`DKK`, `DK`). The pattern
 * below accepts letters, digits, dash and underscore, which covers those
 * examples and keeps a path segment free of anything that needs encoding.
 */
export const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** ISO 4217 currency code, as Billy uses it for currencyId. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** ISO 3166-1 alpha-2 country code, as Billy uses it for countryId. */
export const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/** Largest amount a write accepts, in the currency's major unit (kroner). */
export const MAX_AMOUNT = 1_000_000_000;

/** A calendar date written YYYY-MM-DD that exists. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A positive amount of at most two decimals and at most MAX_AMOUNT. Billy sends and takes amounts as decimals. */
export function isAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_AMOUNT &&
    Math.abs(Math.round(value * 100) - value * 100) < 1e-6
  );
}

export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && RECORD_ID_PATTERN.test(value);
}

export function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

/** Only the last four characters of a bank number, as `••••1234`; nothing when there is none. */
export function lastFour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, '');
  if (compact === '') return undefined;
  return `••••${compact.slice(-4)}`;
}

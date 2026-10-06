import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export const isCountryCode = (value: string | null | undefined): value is string =>
  Boolean(value && /^[A-Z]{2}$/.test(value) && isSupportedCountry(value as CountryCode));

export function toE164(raw: string | null | undefined, country?: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, isCountryCode(country) ? (country as CountryCode) : undefined);
  return parsed?.isValid() ? parsed.number : null;
}

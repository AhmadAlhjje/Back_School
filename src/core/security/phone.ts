import { z } from 'zod';

const ARABIC_INDIC_ZERO = 0x0660; // ٠
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0; // ۰

/** Converts Arabic-Indic and Eastern Arabic-Indic digits to ASCII digits. */
export function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= EASTERN_ARABIC_INDIC_ZERO ? EASTERN_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO;
    return String(code - base);
  });
}

/**
 * Canonical phone form: ASCII digits with an optional leading '+'.
 * "00" international prefixes become '+'. Separators (spaces, dashes, dots, parentheses) are removed.
 */
export function normalizePhone(raw: string): string {
  let value = toAsciiDigits(raw.trim()).replace(/[\s\-.()‎‏]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return value;
}

export const PHONE_PATTERN = /^\+?\d{8,15}$/;

/** Zod schema that normalizes then validates a phone number. */
export const phoneSchema = z
  .string()
  .min(1)
  .max(32)
  .transform(normalizePhone)
  .refine((value) => PHONE_PATTERN.test(value), { message: 'رقم الهاتف غير صالح' });

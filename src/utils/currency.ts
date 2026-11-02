export function formatMinorCurrency(
  minorUnits: number,
  currency: string,
  locale?: string | string[]
): string | null {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0 ||
      typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return null;
  }

  try {
    const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
    // ISO 4217 currencies do not all have two fractional digits (for example,
    // JPY commonly has zero, while KWD has three). Use the formatter's currency
    // precision so the UI matches the minor-unit scale used by the database.
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
    if (typeof fractionDigits !== 'number' || !Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) return null;
    const scale = 10 ** fractionDigits;
    const majorUnits = minorUnits / scale;
    if (!Number.isFinite(majorUnits)) return null;
    return formatter.format(majorUnits);
  } catch {
    return null;
  }
}

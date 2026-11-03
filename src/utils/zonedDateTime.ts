export function resolveUniqueLocalDateTime(value: string, timeZone: string): Date | null {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/.exec(value);
  if (!match || !timeZone) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(naive);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || hour > 23 || minute > 59) return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
  } catch {
    return null;
  }

  const partsAt = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
      year: Number(values.year), month: Number(values.month), day: Number(values.day),
      hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second)
    };
  };
  const sameWallTime = (instant: number) => {
    const parts = partsAt(instant);
    return parts.year === year && parts.month === month && parts.day === day &&
      parts.hour === hour && parts.minute === minute && parts.second === 0;
  };

  // Collect every UTC offset in the surrounding 72-hour window. This catches
  // both sides of a daylight-saving transition without trusting Date's silent
  // normalization of nonexistent or repeated local wall-clock times.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 60 * 60 * 1000;
    const local = partsAt(sample);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day,
      local.hour, local.minute, local.second);
    offsets.add(localAsUtc - sample);
  }

  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (sameWallTime(candidate)) candidates.add(candidate);
  }
  if (candidates.size !== 1) return null;
  return new Date([...candidates][0]);
}

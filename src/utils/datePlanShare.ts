export type DatePlanShareDetails = {
  venueName: string;
  dateTime: string;
  timeZone: string;
};

export type DatePlanShareLabels = {
  title: string;
  prefix: string;
  reminder: string;
};

export type DatePlanShareResult = 'shared' | 'copied' | 'cancelled' | 'unavailable';

const normalizeLine = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s{2,}/g, ' ').trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
};

export function buildDatePlanShareText(
  plan: DatePlanShareDetails,
  labels: Pick<DatePlanShareLabels, 'prefix' | 'reminder'>
): string | null {
  const venueName = normalizeLine(plan.venueName, 120);
  const dateTime = normalizeLine(plan.dateTime, 120);
  const timeZone = normalizeLine(plan.timeZone, 80);
  const prefix = normalizeLine(labels.prefix, 120);
  const reminder = normalizeLine(labels.reminder, 240);
  if (!venueName || !dateTime || !timeZone || !prefix || !reminder) return null;
  return [prefix, venueName, dateTime + ' (' + timeZone + ')', reminder].join('\\n');
}

export async function shareDatePlanText(
  text: string,
  title: string,
  api: {
    share?: (data: { title: string; text: string }) => Promise<void>;
    writeText?: (value: string) => Promise<void>;
  }
): Promise<DatePlanShareResult> {
  if (!text.trim() || !title.trim()) return 'unavailable';
  if (api.share) {
    try {
      await api.share({ title, text });
      return 'shared';
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
        return 'cancelled';
      }
    }
  }
  if (api.writeText) {
    try {
      await api.writeText(text);
      return 'copied';
    } catch {
      // Clipboard permissions and secure-context restrictions vary by browser.
    }
  }
  return 'unavailable';
}

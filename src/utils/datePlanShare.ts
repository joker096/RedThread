export type DatePlanShareDetails = {
  place: string;
  day: string;
  time: string;
};

export type DatePlanShareLabels = {
  prefix: string;
  reminder: string;
};

export type DatePlanSharePayload = {
  title: string;
  text: string;
};

export type DatePlanShareActions = {
  share?: (payload: DatePlanSharePayload) => Promise<void>;
  copy?: (text: string) => Promise<void>;
};

export type DatePlanShareResult = 'shared' | 'copied' | 'cancelled' | 'unavailable';

export function buildDatePlanShareText(
  plan: DatePlanShareDetails,
  labels: DatePlanShareLabels
): string | null {
  const normalizeLine = (value: unknown) => typeof value === 'string'
    ? value.replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s{2,}/g, ' ').trim()
    : '';
  const place = normalizeLine(plan.place);
  const day = normalizeLine(plan.day);
  const time = normalizeLine(plan.time);
  const prefix = normalizeLine(labels.prefix);
  const reminder = normalizeLine(labels.reminder);
  if (!place || !day || !time || !prefix || !reminder) return null;
  if (place.length > 300 || day.length > 100 || time.length > 80) return null;
  return [prefix, place, `${day}, ${time}`, reminder].join('\\n');
}

export async function shareDatePlanText(
  text: string,
  title: string,
  actions: DatePlanShareActions
): Promise<DatePlanShareResult> {
  if (!text.trim() || !title.trim()) return 'unavailable';

  if (actions.share) {
    try {
      await actions.share({ title, text });
      return 'shared';
    } catch (error) {
      // A user closing the native share sheet is an explicit cancellation,
      // not a failed share. Never copy to the clipboard after AbortError.
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
        return 'cancelled';
      }
    }
  }

  if (actions.copy) {
    try {
      await actions.copy(text);
      return 'copied';
    } catch {
      return 'unavailable';
    }
  }

  return 'unavailable';
}

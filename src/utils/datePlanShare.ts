export type DatePlanShareDetails = {
  place: string;
  day: string;
  time: string;
};

export type DatePlanShareLabels = {
  prefix: string;
  reminder: string;
};

export function buildDatePlanShareText(
  plan: DatePlanShareDetails,
  labels: DatePlanShareLabels
): string | null {
  const normalizeLine = (value: unknown) => typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    : '';
  const place = normalizeLine(plan.place);
  const day = normalizeLine(plan.day);
  const time = normalizeLine(plan.time);
  const prefix = normalizeLine(labels.prefix);
  const reminder = normalizeLine(labels.reminder);
  if (!place || !day || !time || !prefix || !reminder) return null;
  if (place.length > 300 || day.length > 100 || time.length > 40) return null;
  return [prefix, place, `${day}, ${time}`, reminder].join('\n');
}

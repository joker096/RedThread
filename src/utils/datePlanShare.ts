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
  const place = typeof plan.place === 'string' ? plan.place.trim() : '';
  const day = typeof plan.day === 'string' ? plan.day.trim() : '';
  const time = typeof plan.time === 'string' ? plan.time.trim() : '';
  const prefix = typeof labels.prefix === 'string' ? labels.prefix.trim() : '';
  const reminder = typeof labels.reminder === 'string' ? labels.reminder.trim() : '';
  if (!place || !day || !time || !prefix || !reminder) return null;
  if (place.length > 300 || day.length > 100 || time.length > 40) return null;
  return [prefix, place, `${day}, ${time}`, reminder].join('\n');
}

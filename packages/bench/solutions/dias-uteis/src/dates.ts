const DAY = 24 * 60 * 60 * 1000;

/** Adds business days (Monday to Friday) to a date, in UTC. */
export function addBusinessDays(date: Date, days: number): Date {
  let current = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    current = new Date(current.getTime() + DAY);
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) added++;
  }
  return current;
}

/** Formats a date as DD/MM/YYYY (UTC). */
export function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

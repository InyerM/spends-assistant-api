/**
 * Get current date and time in Colombia timezone
 */
export function getCurrentColombiaTimes(): { date: string; time: string } {
  const now = new Date();
  
  const formatter = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const values: Record<string, string> = {};
  
  parts.forEach(({ type, value }) => {
    values[type] = value;
  });

  const date = `${values.year}-${values.month}-${values.day}`;
  const time = `${values.hour}:${values.minute}`;

  return { date, time };
}

/**
 * Convert DD/MM/YYYY to YYYY-MM-DD
 */
export function convertDateFormat(ddmmyyyy: string): string {
  const [day, month, year] = ddmmyyyy.split('/');
  return `${year}-${month}-${day}`;
}

/**
 * Convert YYYY-MM-DD to DD/MM/YYYY
 */
export function formatDateForDisplay(yyyymmdd: string): string {
  const [year, month, day] = yyyymmdd.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Validate and fix a parsed date string.
 * Accepts DD/MM/YYYY and attempts to fix common issues from AI parsing.
 * Returns null if the date cannot be validated (caller should use current Colombia time).
 */
export function validateAndFixDate(date: string | null | undefined): string | null {
  if (!date) return null;

  const trimmed = date.trim();

  // Already in DD/MM/YYYY format
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('/').map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      return trimmed;
    }
    return null;
  }

  // Handle MM/DD/YYYY (American format) — swap to DD/MM/YYYY if the month looks valid
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const parts = trimmed.split('/');
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);

    if (year < 2000 || year > 2100) return null;

    // If first value > 12, it's likely DD/MM/YYYY with single digit
    if (first > 12 && second >= 1 && second <= 12) {
      return `${String(first).padStart(2, '0')}/${String(second).padStart(2, '0')}/${year}`;
    }

    // If second value > 12, it might be MM/DD/YYYY — swap
    if (second > 12 && first >= 1 && first <= 12) {
      return `${String(second).padStart(2, '0')}/${String(first).padStart(2, '0')}/${year}`;
    }

    // Both <= 12, assume DD/MM/YYYY (Colombian convention)
    return `${String(first).padStart(2, '0')}/${String(second).padStart(2, '0')}/${year}`;
  }

  // Handle YYYY-MM-DD (ISO format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    }
    return null;
  }

  // Could not parse — return null so system uses current Colombia time
  return null;
}

/**
 * Validate and fix a parsed time string.
 * Accepts HH:MM in 24-hour format.
 * Returns null if the time cannot be validated.
 */
export function validateAndFixTime(time: string | null | undefined): string | null {
  if (!time) return null;

  const trimmed = time.trim();

  // Already in HH:MM format
  if (/^\d{2}:\d{2}$/.test(trimmed)) {
    const [hours, minutes] = trimmed.split(':').map(Number);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return trimmed;
    }
    return null;
  }

  // Single digit hour, e.g. "8:30"
  if (/^\d{1}:\d{2}$/.test(trimmed)) {
    const [hours, minutes] = trimmed.split(':').map(Number);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    return null;
  }

  return null;
}

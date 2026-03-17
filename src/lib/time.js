export function isoNow() {
  return new Date().toISOString();
}

export function toIso(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function compareIsoStrings(left, right) {
  return new Date(left).getTime() - new Date(right).getTime();
}

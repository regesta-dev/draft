export function assertCanonicalTimestamp(
  value: string,
  label = 'Timestamp',
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }

  const time = Date.parse(value)

  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO 8601`)
  }

  return value
}

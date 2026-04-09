export function toReadableDate(epochSeconds: number | undefined): string {
  if (!epochSeconds) return 'N/A';

  return new Date(epochSeconds * 1000).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

export function shortHash(value: string | undefined, visible = 8): string {
  if (!value) return 'N/A';
  if (value.length <= visible * 2 + 3) return value;
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

export type SearchParams = Record<string, string | string[] | undefined>;

export function blockDetailHref(height: number): string {
  return `/blocks/${height}`;
}

export function parseBlockHeightParam(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function cursorFromSearchParams(searchParams: SearchParams): string | undefined {
  return typeof searchParams.cursor === 'string' ? searchParams.cursor : undefined;
}

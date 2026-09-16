/** Parse an HTTP Range header (single range only) against a known size. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return 'invalid';
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return 'invalid';
  let start: number;
  let end: number;
  if (startStr === '') {
    const suffix = Number(endStr);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

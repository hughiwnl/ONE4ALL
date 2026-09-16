/** Only allow relative, same-site redirect targets (prevents open redirects). */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback = '/dashboard',
): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\r\n\0]/.test(value)) return fallback;
  return value;
}

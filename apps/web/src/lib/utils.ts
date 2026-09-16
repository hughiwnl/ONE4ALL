import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Read a text field from a FormData, ignoring file entries. */
export function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

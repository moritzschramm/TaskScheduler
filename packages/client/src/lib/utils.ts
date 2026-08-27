import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn-vue's class merge helper: conditional classes, last Tailwind rule wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

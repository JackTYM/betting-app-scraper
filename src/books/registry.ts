import { fanduel } from './fanduel';
import { caesars } from './caesars';
import { draftkings } from './draftkings';
import type { BookConfig } from './types';

export const BOOKS: BookConfig[] = [fanduel, caesars, draftkings];

export function getBook(key: string): BookConfig | undefined {
  return BOOKS.find((b) => b.key === key);
}

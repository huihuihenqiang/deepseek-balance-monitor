import { PetCatalogEntry } from './types';

export const BUILTIN_PET_CATALOG: PetCatalogEntry[] = [
  {
    slug: 'anya-2',
    displayName: '阿尼亚',
    description: 'A Codex-style digital pet version of Anya Forger from SPY x FAMILY.',
    source: 'builtin',
    bundled: true,
  },
  {
    slug: 'tiko',
    displayName: 'Tiko',
    description: 'An original tiny yellow utility robot pet with curious camera eyes, treads, and friendly clamp arms.',
    source: 'builtin',
    bundled: true,
  },
  {
    slug: 'xiaoyu-3',
    displayName: '小雨',
    description: 'A friendly chibi digital pet inspired by the reference portrait, with a bright floral vest and calm welcoming personality.',
    source: 'builtin',
    bundled: true,
  },
];

export function slugifyPetName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'pet';
}

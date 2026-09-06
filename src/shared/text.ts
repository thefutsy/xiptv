export function fold(input: string): string {
  return input.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

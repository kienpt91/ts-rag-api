/** 1-based rank of the first relevant result, or null when none of the results is relevant. */
export function firstRelevantRank<T>(results: T[], isRelevant: (item: T) => boolean): number | null {
  const index = results.findIndex(isRelevant);
  return index === -1 ? null : index + 1;
}

export function hitAtK(ranks: (number | null)[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.filter((r) => r !== null && r <= k).length / ranks.length;
}

/** Mean reciprocal rank; questions without a relevant result contribute 0. */
export function meanReciprocalRank(ranks: (number | null)[]): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / ranks.length;
}

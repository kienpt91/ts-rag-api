const STOPWORDS: Record<string, true> = Object.fromEntries(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to us was we were what when " +
    "where which who whom why will with would you your"
  )
    .split(" ")
    .map((word) => [word, true] as const),
);

/** Very small English stemmer: enough to merge plurals and common verb endings. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4 && /(ch|sh|x|z|s)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Lowercased, stemmed terms with stopwords removed. Falls back to all words when the text is
 * made only of stopwords so that short queries such as "what is it" still produce a signal.
 */
export function terms(text: string): string[] {
  const all = words(text);
  const content = all.filter((w) => !Object.hasOwn(STOPWORDS, w));
  return (content.length > 0 ? content : all).map(stem);
}

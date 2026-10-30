/** "Title > Heading" for a chunk, without repeating the title when the heading path already starts with it. */
export function chunkLabel(chunk: { title: string; heading: string }): string {
  if (!chunk.heading) return chunk.title;
  return chunk.heading === chunk.title || chunk.heading.startsWith(`${chunk.title} > `) ? chunk.heading : `${chunk.title} > ${chunk.heading}`;
}

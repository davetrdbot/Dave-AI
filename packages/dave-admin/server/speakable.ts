const MAX_SPEAK_CHARS = 2500;

/** Strip markdown and cut to a speakable length -- a reply full of ** and | reads badly aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_#>`|]/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

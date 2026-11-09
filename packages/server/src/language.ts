// The language the project's memory is written in: one per project, set by
// `memmem-server project add --language` (default en) and recorded in
// projects.json and in the transcripts repo's project.json. Conversation with
// the coding agent follows the user's language and is not configured; CLI and
// log output are English.

/** Memory languages that have a template (templates/memory-repo/<lang>). */
export const MEMORY_LANGUAGES = ["en", "ko"] as const;
export type MemoryLanguage = (typeof MEMORY_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: MemoryLanguage = "en";

export const LANGUAGE_NAMES: Record<string, string> = { en: "English", ko: "Korean (한국어)", ja: "Japanese", zh: "Chinese" };

export function isMemoryLanguage(value: unknown): value is MemoryLanguage {
  return typeof value === "string" && (MEMORY_LANGUAGES as readonly string[]).includes(value);
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/** The instruction sentence given to reflection and to the init pre-answer turn. */
export function memoryLanguageInstruction(code: string): string {
  const name = languageName(code);
  return `Language: write memory in ${name}. Sessions and remember notes in other languages are recorded in ${name}. Keep proper nouns, titles, identifiers and code verbatim.`;
}

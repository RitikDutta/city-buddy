export type ReplyLanguage = "en" | "hinglish" | "hi";

export function replyLanguage(message: string): ReplyLanguage {
  const devanagari = /\p{Script=Devanagari}/u.test(message);
  if (
    devanagari &&
    (!/\p{Script=Latin}/u.test(message) ||
      /(?:यहाँ|यहां|वहाँ|वहां|कितन[ाीे]|कैसे|कहाँ|कहां|बताइए|बताओ|चाहिए|[हथ][ैी](?:ं)?)(?=[\s?!।.,]|$)/u.test(
        message,
      ))
  )
    return "hi";
  const romanHindi =
    /\b(?:yah+a+n?|yaha?n?|yhaa|yhan|idhar|wah+a+n?|waha?n?|udhar|kit+t?n[aei]|kit+t[aei]|kaise|kese|mujhe|muje|tumhe|meri|kya|kahan|kahaan|batao|btao|bataye|dikha(?:o|na)|dekhu[nm]?|dekhna|chahiye|jana|jaana|jaun|jau|jaao|lagega|lagegi|ghumne|ghoomne|gaadi|peda?l|paidal|door[iy]|shukriya|namaste|dhanyavaad|dhanyavad|itihaas)\b/i;
  if (
    romanHindi.test(message) ||
    (/\b(?:hai|hain|nahi|nahin|karo|karna|karni|paas|dur|door)\b[\s.!?।]*$/i.test(
      message,
    ) &&
      !/\b(?:the|a|this|that|open|shut|close|front|back)\s+door\b/i.test(
        message,
      ))
  )
    return "hinglish";
  return "en";
}

export function inLanguage(language: ReplyLanguage) {
  return (english: string, hinglish: string, hindi: string) =>
    language === "hi" ? hindi : language === "hinglish" ? hinglish : english;
}

export function languageInstruction(language: ReplyLanguage) {
  return inLanguage(language)(
    "Use the language of the latest actual user message. If it is English, write the full reply and any follow-up in English.",
    "Write this reply, any clarification and any follow-up in natural Hinglish using Latin letters. For example, 'Yahan se Jal Mahal kitna door hai?' takes an answer like 'Yahan se Jal Mahal lagbhag 3 km door hai.' Use Latin letters even if earlier turns or maps results are in Devanagari.",
    "Write this reply, any clarification and any follow-up in Hindi using Devanagari.",
  );
}

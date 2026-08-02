/**
 * Minimal HTML → plain-text normalizer for inbound email bodies (v4.3.0,
 * #24). Structural only — tag stripping and entity decoding, never a
 * parse of the natural-language CONTENT — so it sits with the other
 * language-independent structural regexes this codebase allows (rule 4),
 * the same way an ISO-datetime or email-shape pattern does.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    // &amp; decodes LAST, deliberately. Decoding it first would cascade a
    // doubly-escaped entity: literal text "&lt;" is legitimately encoded in
    // source HTML as "&amp;lt;" (escape the ampersand so the reader sees the
    // four characters, not a "<"). Decode &amp; first and the leftover "lt;"
    // becomes "&lt;", which the very next replace then turns into "<" — one
    // unescape too many. Kept last, "&amp;lt;" correctly survives as the
    // literal text "&lt;".
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

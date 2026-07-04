// Post-call summary: builds the prompt sent to Astra when capture stops.
// Pure module (no DOM/chrome) so the truncation and formatting logic is
// node-testable.

const MAX_TRANSCRIPT_CHARS = 12000; // keep the tail — the close of a call
                                    // usually matters more than the start

/**
 * @param {Array<{t:number, text:string}>} transcript  finalized utterances
 *        (t = startMs)
 * @param {Array<{q:string, answered:boolean}>} questions detected questions
 * @param {number} [maxChars] transcript budget
 * @returns {string} prompt for the Astra answer persona
 */
export function buildSummaryPrompt(transcript, questions, maxChars = MAX_TRANSCRIPT_CHARS) {
  const lines = (transcript || []).map(
    (u) => `[${Math.round((u.t || 0) / 1000)}s] ${u.text}`
  );
  let transcriptText = lines.join('\n');
  let truncated = false;
  if (transcriptText.length > maxChars) {
    transcriptText = transcriptText.slice(-maxChars);
    // cut at the next line boundary so we don't start mid-utterance
    const nl = transcriptText.indexOf('\n');
    if (nl > 0) transcriptText = transcriptText.slice(nl + 1);
    truncated = true;
  }

  const questionLines = (questions || []).length
    ? questions
        .map(
          (item, i) =>
            `${i + 1}. [${item.answered ? 'answered on call' : 'NEEDS FOLLOW-UP'}] ${item.q}`
        )
        .join('\n')
    : '(none detected)';

  return `You are a pre-sales assistant. The call has just ended. Based on the transcript and the detected customer questions below, produce a post-call wrap-up in markdown with EXACTLY these three sections:

## Meeting Summary
3-6 concise bullet points of what was discussed and any decisions or concerns raised.

## Questions Asked
List every detected question. Prefix each with ✅ if it was answered on the call, or ⏳ if it needs follow-up. Keep each to one line.

## Follow-up Email Draft
A short, professional email from the consultant to the customer: thank them, recap the key points, address the open items at a high level, and propose a concrete next step. Ready to send — no placeholders except [Customer Name] and [Your Name].

Detected questions:
${questionLines}

Call transcript${truncated ? ' (earlier part truncated)' : ''}:
${transcriptText}`;
}

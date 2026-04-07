const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Given a transcript array (from Recall.ai), produce a structured meeting summary.
 * Returns { summary, decisions, actionItems } or null if transcript is empty.
 */
async function generateSummary(transcript) {
  if (!transcript || !transcript.length) return null;

  // Convert transcript array to plain readable text
  const text = transcript
    .map(seg => {
      const speaker = seg.participant?.name || 'Unknown';
      const words = (seg.words || []).map(w => w.text).join(' ').trim();
      return words ? `${speaker}: ${words}` : null;
    })
    .filter(Boolean)
    .join('\n');

  if (!text.trim()) return null;

  const prompt = `You are a professional meeting assistant. Analyse this meeting transcript and respond with valid JSON only — no markdown, no commentary.

Return exactly this structure:
{
  "summary": "2-4 sentence overview of the meeting purpose and outcome",
  "decisions": ["decision 1", "decision 2"],
  "actionItems": [
    { "owner": "Name or Unknown", "action": "what they agreed to do" }
  ]
}

If there are no decisions or action items, return empty arrays.

TRANSCRIPT:
${text}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 1024,
  });

  const raw = response.choices[0]?.message?.content?.trim();
  if (!raw) return null;

  // Strip any accidental markdown fences
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim();
  return JSON.parse(json);
}

module.exports = { generateSummary };

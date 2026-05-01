export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { image_base64, image_mime } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 20,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: image_mime || 'image/jpeg', data: image_base64 }},
          { type: 'text', text: "Leggi la targa italiana. Solo i caratteri (es: FA036BV). Se non c'e' targa: NESSUNA_TARGA" }
        ]}]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const plate = (data.content?.[0]?.text || 'NESSUNA_TARGA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return res.status(200).json({ plate });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

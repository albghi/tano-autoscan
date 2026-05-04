export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { image_base64, image_mime, plate } = req.body;

    // MODE 1: Lecture de plaque par IA (image envoyée)
    if (image_base64) {
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
      const detectedPlate = (data.content?.[0]?.text || 'NESSUNA_TARGA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      return res.status(200).json({ plate: detectedPlate });
    }

    // MODE 2: Lookup véhicule par plaque (targa.co.it)
    if (plate) {
      const user = process.env.TARGA_USER;
      const pass = process.env.TARGA_PASS;

      const url = `https://www.regcheck.org.uk/api/reg.asmx/CheckItaly?RegistrationNumber=${encodeURIComponent(plate)}&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

      const targaRes = await fetch(url);
      const xml = await targaRes.text();

      // Parse XML response
      const getValue = (tag) => {
        const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return match ? match[1].trim() : '';
      };

      const vehicleData = {
        make: getValue('make') || getValue('Make'),
        model: getValue('model') || getValue('Model'),
        year: getValue('RegistrationYear') || getValue('year'),
        color: getValue('color') || getValue('Color'),
        fuel: getValue('fuel') || getValue('Fuel'),
        cc: getValue('cc') || getValue('EngineSize'),
        hp: getValue('bhp') || getValue('hp'),
        immatricolazione: getValue('RegistrationDate'),
        revisione: getValue('MOTExpiryDate') || getValue('revisione'),
        raw: xml.length < 2000 ? xml : ''
      };

      return res.status(200).json({ vehicleData });
    }

    return res.status(400).json({ error: 'Parametri mancanti' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

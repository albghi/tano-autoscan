export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { image_base64, image_mime, plate } = req.body || {};

    // ── MODE 1: lettura targa con l'IA (immagine inviata) ──────────────
    if (image_base64) {
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'Lettura targa: chiave ANTHROPIC_API_KEY mancante su Vercel.' });
      }
      let response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 20,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: image_mime || 'image/jpeg', data: image_base64 }},
              { type: 'text', text: "Leggi la targa italiana. Rispondi SOLO con i caratteri (es: FA036BV). Se non c'e' targa: NESSUNA_TARGA" }
            ]}]
          })
        });
      } catch (e) {
        return res.status(502).json({ error: 'Lettura targa: rete verso l\'IA fallita (' + e.message + ').' });
      }

      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); }
      catch (e) {
        return res.status(502).json({ error: 'Lettura targa: risposta IA non valida (HTTP ' + response.status + '): ' + raw.slice(0, 160) });
      }
      if (!response.ok || data.error) {
        return res.status(response.status || 400).json({ error: 'Lettura targa (IA): ' + (data.error?.message || ('HTTP ' + response.status)) });
      }
      const detectedPlate = (data.content?.[0]?.text || 'NESSUNA_TARGA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      return res.status(200).json({ plate: detectedPlate });
    }

    // ── MODE 2: lookup veicolo per targa (regcheck / targa.co.it) ───────
    if (plate) {
      const user = process.env.TARGA_USER;
      const pass = process.env.TARGA_PASS;
      if (!user || !pass) {
        return res.status(500).json({ error: 'Lookup veicolo: credenziali TARGA_USER/TARGA_PASS mancanti su Vercel.' });
      }

      const url = `https://www.regcheck.org.uk/api/reg.asmx/CheckItaly?RegistrationNumber=${encodeURIComponent(plate)}&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

      let targaRes, xml;
      try {
        targaRes = await fetch(url);
        xml = await targaRes.text();
      } catch (e) {
        return res.status(502).json({ error: 'Lookup veicolo: rete verso targa.co.it fallita (' + e.message + ').' });
      }

      if (!targaRes.ok) {
        return res.status(502).json({ error: 'Lookup veicolo: targa.co.it ha risposto HTTP ' + targaRes.status + '. ' + xml.slice(0, 160) });
      }

      const jsonMatch = xml.match(/<vehicleJson[^>]*>([\s\S]*?)<\/vehicleJson>/i) ||
                        xml.match(/<string[^>]*>([\s\S]*?)<\/string>/i);

      let vehicleData = {};
      if (jsonMatch) {
        try {
          const jsonStr = jsonMatch[1]
            .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
          const parsed = JSON.parse(jsonStr);
          const val = (obj) => {
            if (!obj) return '';
            if (typeof obj === 'string') return obj;
            if (obj.CurrentTextValue !== undefined) return obj.CurrentTextValue;
            return '';
          };
          vehicleData = {
            make: val(parsed.CarMake) || val(parsed.MakeDescription) || '',
            model: val(parsed.CarModel) || val(parsed.ModelDescription) || val(parsed.Description) || '',
            year: parsed.RegistrationYear || '',
            color: val(parsed.Color) || val(parsed.Colour) || '',
            fuel: val(parsed.FuelType) || '',
            cc: val(parsed.EngineSize) || '',
            hp: parsed.PowerCV || val(parsed.PowerCV) || '',
            vin: parsed.Vin || '',
            version: parsed.Version || ''
          };
        } catch (e) {
          return res.status(502).json({ error: 'Lookup veicolo: dato illeggibile da targa.co.it (' + e.message + ').' });
        }
      } else {
        // targa.co.it a répondu mais sans données (targa inconnue ou crédit épuisé)
        vehicleData = { error: 'Nessun dato trovato per questa targa (targa sconosciuta o credito targa.co.it esaurito).' };
      }

      return res.status(200).json({ vehicleData });
    }

    return res.status(400).json({ error: 'Parametri mancanti (né immagine né targa).' });

  } catch (err) {
    return res.status(500).json({ error: 'Errore interno scan: ' + (err && err.message ? err.message : String(err)) });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

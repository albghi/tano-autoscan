export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { image_base64, image_mime, plate, libretto } = req.body;

    // MODE 3: Lettura COMPLETA del libretto di circolazione (carta di circolazione)
    // Usato dalla dashboard di Lisa per il preventivo. Ritorna { libretto: {...} }.
    if (image_base64 && libretto) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 400,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: image_mime || 'image/jpeg', data: image_base64 }},
            { type: 'text', text:
              "Questa e' una carta di circolazione italiana (libretto). Leggi i dati del veicolo e rispondi SOLO con un JSON grezzo, " +
              "senza backtick e senza la parola json, con queste chiavi esatte: targa, marca, modello, cilindrata, alimentazione, anno, telaio. " +
              "Regole: targa = campo (A) in maiuscolo senza spazi; marca = campo (D.1); modello = campo (D.3); " +
              "cilindrata = campo (P.1), solo il numero in cm3; alimentazione = campo (P.3) (es. BENZINA, DIESEL, IBRIDO, GPL, METANO, ELETTRICO); " +
              "anno = anno della prima immatricolazione, campo (B) oppure (I), solo le 4 cifre; telaio = campo (E). " +
              "Se un dato non e' leggibile metti stringa vuota." }
          ]}]
        })
      });
      const data = await response.json();
      if (data.error) return res.status(400).json({ error: 'IA (libretto): ' + data.error.message });

      const textBlock = (data.content || []).find(b => b.type === 'text');
      let txt = (textBlock?.text || '{}').trim();
      txt = txt.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

      let lib;
      try { lib = JSON.parse(txt); }
      catch (e) { return res.status(200).json({ error: 'Lettura libretto non riuscita (formato)', raw: txt.slice(0, 200) }); }

      const S = v => (v == null ? '' : String(v)).trim();
      return res.status(200).json({ libretto: {
        targa:         S(lib.targa).toUpperCase().replace(/[^A-Z0-9]/g, ''),
        marca:         S(lib.marca),
        modello:       S(lib.modello),
        cilindrata:    S(lib.cilindrata).replace(/[^0-9]/g, ''),
        alimentazione: S(lib.alimentazione),
        anno:          S(lib.anno).replace(/[^0-9]/g, '').slice(0, 4),
        telaio:        S(lib.telaio).toUpperCase().replace(/[^A-Z0-9]/g, '')
      }});
    }

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
          model: 'claude-sonnet-5',
          max_tokens: 20,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: image_mime || 'image/jpeg', data: image_base64 }},
            { type: 'text', text: "Leggi la targa italiana. Solo i caratteri (es: FA036BV). Se non c'e' targa: NESSUNA_TARGA" }
          ]}]
        })
      });
      const data = await response.json();
      if (data.error) return res.status(400).json({ error: 'IA (targa): ' + data.error.message });
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

      // Estrai il JSON dalla risposta XML
      const jsonMatch = xml.match(/<vehicleJson[^>]*>([\s\S]*?)<\/vehicleJson>/i) ||
                        xml.match(/<string[^>]*>([\s\S]*?)<\/string>/i);

      let vehicleData = {};

      if (jsonMatch) {
        try {
          const jsonStr = jsonMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();

          const parsed = JSON.parse(jsonStr);

          // Estrai i valori annidati (CurrentTextValue)
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
        } catch(e) {
          vehicleData = { error: 'Parse error: ' + e.message };
        }
      } else {
        vehicleData = { error: 'Nessun dato trovato per questa targa' };
      }

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

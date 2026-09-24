// v2 (24/09/2026): legge anche l'intestatario (C.3 oppure C.2.2 + C.2.1) per il preventivo
function nomeProprio(v){ const t=(v==null?'':String(v)).replace(/\s+/g,' ').trim(); return t.toLowerCase().replace(/(^|[\s'-])([a-zà-ù])/g,(m,a,b)=>a+b.toUpperCase()); }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { image_base64, image_mime, plate, libretto, foto, domanda } = req.body;

    // Pulizia dei due campi che si sporcano piu' spesso.
    // "1598 cm3" -> 1598 (non 15983) ; "15/03/2015" -> 2015 (non 1503).
    const soloCilindrata = v => { const m = String(v == null ? '' : v).replace(/[.\s']/g, '').match(/\d{3,5}/); return m ? m[0] : ''; };
    const soloAnno       = v => { const m = String(v == null ? '' : v).match(/(?:19|20)\d{2}/); return m ? m[0] : ''; };

    // MODE 4: FOTO APERTA — la dashboard manda una foto qualsiasi (+ eventuale domanda).
    // Se e' una carta di circolazione risponde come il MODE 3 ({ tipo:'libretto', libretto:{...} }),
    // altrimenti risponde a parole ({ tipo:'aperto', risposta:'...' }).
    // Non tocca gli altri modi: si attiva solo quando arriva il flag "foto".
    if (image_base64 && foto) {
      const chiesto = (domanda == null ? '' : String(domanda)).trim().slice(0, 600);

      const istruzioni =
        "Sei l'assistente di un'officina meccanica italiana (Officina Tano Evoluzione). " +
        "Guardi le foto che ti manda il meccanico dal telefono: libretti, pezzi usurati, schermate di diagnosi Texa o Autel, " +
        "codici errore, parti del motore, targhe, documenti. " +
        "Rispondi SEMPRE e SOLO con un JSON grezzo, senza backtick e senza la parola json.\n\n" +
        "CASO 1 — se la foto e' una carta di circolazione italiana (libretto), usa questo formato esatto:\n" +
        '{"tipo":"libretto","targa":"","marca":"","modello":"","cilindrata":"","alimentazione":"","anno":"","telaio":"","intestatario":""}\n' +
        "Regole: targa = campo (A) in maiuscolo senza spazi; marca = campo (D.1); modello = campo (D.3); " +
        "cilindrata = campo (P.1), solo il numero in cm3; alimentazione = campo (P.3) (es. BENZINA, DIESEL, IBRIDO, GPL, METANO, ELETTRICO); " +
        "anno = anno della prima immatricolazione, campo (B) oppure (I), solo le 4 cifre; telaio = campo (E). " +
        "intestatario = nome e cognome della persona intestataria: se c'e' il campo (C.3) usa quello (locatario/usufruttuario), altrimenti campo (C.2.2) nome seguito da campo (C.2.1) cognome, es. 'Tatiana Bizgu'; se l'intestatario e' una societa' metti la ragione sociale (C.2.1). Non mettere mai data o luogo di nascita, codice fiscale o indirizzo. " +
        "Se un dato non e' leggibile metti stringa vuota.\n\n" +
        "CASO 2 — in tutti gli altri casi usa questo formato:\n" +
        '{"tipo":"aperto","risposta":"..."}\n' +
        "Dentro risposta scrivi in italiano, parlando al meccanico da collega: di' cosa vedi di concreto e utile, " +
        "leggi i codici, le sigle e i numeri se ci sono, e se serve di' cosa controlleresti dopo. " +
        "Da 2 a 6 frasi, niente elenchi puntati, niente premesse. " +
        "Se la foto e' poco leggibile dillo e spiega come rifarla. " +
        "Non inventare mai un dato che non si vede: se non sei sicuro, dillo.";

      const testo = chiesto
        ? (istruzioni + "\n\nDomanda del meccanico su questa foto: " + chiesto)
        : istruzioni;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 900,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: image_mime || 'image/jpeg', data: image_base64 }},
            { type: 'text', text: testo }
          ]}]
        })
      });
      const data = await response.json();
      if (data.error) return res.status(400).json({ error: 'IA (foto): ' + data.error.message });

      const textBlock = (data.content || []).find(b => b.type === 'text');
      let txt = (textBlock?.text || '').trim();
      txt = txt.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

      const S = v => (v == null ? '' : String(v)).trim();

      let out = null;
      try { out = JSON.parse(txt); } catch (e) { out = null; }

      // Se il modello non ha risposto in JSON, il testo vale come risposta aperta.
      if (!out || typeof out !== 'object') {
        return res.status(200).json({ tipo: 'aperto', risposta: txt || 'Non riesco a leggere questa foto.' });
      }

      if (out.tipo === 'libretto') {
        return res.status(200).json({ tipo: 'libretto', libretto: {
          targa:         S(out.targa).toUpperCase().replace(/[^A-Z0-9]/g, ''),
          marca:         S(out.marca),
          modello:       S(out.modello),
          cilindrata:    soloCilindrata(out.cilindrata),
          alimentazione: S(out.alimentazione),
          anno:          soloAnno(out.anno),
          telaio:        S(out.telaio).toUpperCase().replace(/[^A-Z0-9]/g, ''),
          intestatario:  nomeProprio(out.intestatario)
        }});
      }

      return res.status(200).json({ tipo: 'aperto', risposta: S(out.risposta) || 'Non riesco a leggere questa foto.' });
    }

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
              "senza backtick e senza la parola json, con queste chiavi esatte: targa, marca, modello, cilindrata, alimentazione, anno, telaio, intestatario. " +
              "Regole: targa = campo (A) in maiuscolo senza spazi; marca = campo (D.1); modello = campo (D.3); " +
              "cilindrata = campo (P.1), solo il numero in cm3; alimentazione = campo (P.3) (es. BENZINA, DIESEL, IBRIDO, GPL, METANO, ELETTRICO); " +
              "anno = anno della prima immatricolazione, campo (B) oppure (I), solo le 4 cifre; telaio = campo (E). " +
              "intestatario = nome e cognome della persona intestataria: se c'e' il campo (C.3) usa quello (locatario/usufruttuario), altrimenti campo (C.2.2) nome seguito da campo (C.2.1) cognome, es. 'Tatiana Bizgu'; se l'intestatario e' una societa' metti la ragione sociale (C.2.1). Non mettere mai data o luogo di nascita, codice fiscale o indirizzo. " +
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
        cilindrata:    soloCilindrata(lib.cilindrata),
        alimentazione: S(lib.alimentazione),
        anno:          soloAnno(lib.anno),
        telaio:        S(lib.telaio).toUpperCase().replace(/[^A-Z0-9]/g, ''),
        intestatario:  nomeProprio(lib.intestatario)
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

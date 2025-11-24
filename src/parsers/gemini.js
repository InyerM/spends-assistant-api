
/**
 * Parses expense text using Google Gemini 2.5 Flash.
 * @param {string} text - The text to parse (email, SMS, or manual message).
 * @param {string} apiKey - Gemini API Key.
 * @returns {Promise<Object>} - The parsed expense object.
 */
export async function parseExpense(text, apiKey) {
  const model = "gemini-2.5-flash"; // Or gemini-2.5-flash-002
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const systemPrompt = `
Eres un asistente financiero colombiano experto que extrae datos de gastos.

ENTRADAS POSIBLES:
1. Email de Bancolombia: "Bancolombia: Compraste $X en Y con tu T.Deb/Crédito *XXXX, el DD/MM/YYYY a las HH:MM"
2. SMS de Nequi (número 85954): "Nequi: Pagaste $X en Y. Saldo: $Z"
3. Mensaje manual: "20k en rappi", "50mil de almuerzo", "compré 100mil de mercado"

SALIDA (JSON estricto sin markdown):
{
  "monto": number,
  "descripcion": string,
  "categoria": "comida|transporte|entretenimiento|compras|servicios|salud|educacion|hogar|tecnologia|suscripciones|otros",
  "banco": "bancolombia|nequi|daviplata|efectivo|otro",
  "tipo_pago": "debito|credito|efectivo|transferencia|qr",
  "fuente": "bancolombia_email|nequi_sms|manual",
  "confianza": number (0-100),
  "fecha_original": string | null,
  "hora_original": string | null
}

CATEGORIZACIÓN INTELIGENTE (Colombia):

Comida:
- rappi, uber eats, domicilios, ifood, pedidos ya
- restaurantes, almuerzo, desayuno, cena, panadería
- cafe, juan valdez, starbucks, oma
- mercado, frutas, verduras

Transporte:
- uber, didi, cabify, beat, indriver, taxi
- bus, metro, transmilenio, sitp
- gasolina, terpel, mobil, esso
- parqueadero, peaje

Entretenimiento:
- netflix, spotify, disney+, prime video, hbo max
- cine, cinemark, cinepolis, procinal
- bares, discotecas, rumba, cerveza
- videojuegos, codashop, steam, epic games, xbox, playstation

Compras:
- exito, carrefour, jumbo, olimpica, makro, metro
- ara, d1, justo & bueno, tiendas
- supermercado, mercado, víveres
- ropa, zapatos, falabella, éxito

Salud:
- farmatodo, cruz verde, cafam, colsubsidio
- droguería, farmacia, medicamentos
- consulta médica, médico, odontólogo, laboratorio
- gimnasio, smartfit, bodytech, fitpal

Servicios:
- epm, codensa, eaab, gas natural
- claro, movistar, tigo, wom, virgin mobile
- internet, cable, televisión
- agua, luz, gas, servicios públicos

Educación:
- cursos, udemy, platzi, coursera
- libros, librería, nacional, lerner
- universidad, colegio, matrícula, pensión

Hogar:
- homecenter, sodimac, easy
- ferretería, plomería, electricidad
- muebles, alkosto, ktronix
- reparaciones, mantenimiento

Tecnología:
- apple, samsung, xiaomi, celulares
- computadores, portátiles, tablets
- accesorios, audifonos, cargadores
- falabella tech, alkomprar, mercado libre

Suscripciones:
- membresías, suscripciones mensuales
- cloud storage, icloud, google one
- software, adobe, office 365

REGLAS DE PARSING:

Montos:
- Eliminar: $, puntos (.), comas (,)
- "k" o "mil" = ×1000 (ej: "20k" → 20000, "50mil" → 50000)
- Formato común colombiano: $119.000,00 → 119000

Fuente:
- Si texto contiene "Bancolombia:" o viene de notificaciones@bancolombia → fuente: "bancolombia_email"
- Si texto contiene "Nequi:" o menciona número 85954 → fuente: "nequi_sms"
- En otro caso → fuente: "manual"

Banco:
- Si fuente es bancolombia_email → banco: "bancolombia"
- Si fuente es nequi_sms → banco: "nequi"
- Si es manual y no se especifica → banco: "otro"

Tipo de pago:
- Si SMS menciona "T.Deb" o "débito" → tipo_pago: "debito"
- Si SMS menciona "Crédito" o "T.Cred" → tipo_pago: "credito"
- Si SMS de Nequi → tipo_pago: "transferencia"
- Si manual sin especificar → tipo_pago: "efectivo"

Confianza:
- 100: SMS bancario con toda la info completa
- 90: SMS bancario con info parcial
- 80-85: Mensaje manual con formato claro
- 70-75: Mensaje manual ambiguo
- <70: Muy ambiguo o falta info crítica

FECHAS Y HORAS (SOLO para SMS bancarios):

Para mensajes MANUALES:
- NO incluir fecha ni hora en el JSON
- Usar: "fecha_original": null, "hora_original": null

Para SMS con fecha EXPLÍCITA:
- Bancolombia: "el 23/11/2024 a las 19:47"
  → "fecha_original": "23/11/2024", "hora_original": "19:47"
- Nequi: generalmente NO tiene fecha
  → "fecha_original": null, "hora_original": null

IMPORTANTE:
- "fecha_original" y "hora_original" son OPCIONALES
- Solo incluirlos si el SMS los menciona EXPLÍCITAMENTE
- El sistema convertirá estos valores o asignará la fecha/hora actual

EJEMPLOS:

Input: "20000 en almuerzo"
Output: {
  "monto": 20000,
  "descripcion": "almuerzo",
  "categoria": "comida",
  "banco": "otro",
  "tipo_pago": "efectivo",
  "fuente": "manual",
  "confianza": 85,
  "fecha_original": null,
  "hora_original": null
}

Input: "Bancolombia: Compraste $119.000,00 en CODASHOP con tu T.Deb *7799, el 23/11/2024 a las 19:47"
Output: {
  "monto": 119000,
  "descripcion": "CODASHOP",
  "categoria": "entretenimiento",
  "banco": "bancolombia",
  "tipo_pago": "debito",
  "fuente": "bancolombia_email",
  "confianza": 100,
  "fecha_original": "23/11/2024",
  "hora_original": "19:47"
}

Input: "Nequi: Pagaste $50.000 en UBER"
Output: {
  "monto": 50000,
  "descripcion": "UBER",
  "categoria": "transporte",
  "banco": "nequi",
  "tipo_pago": "transferencia",
  "fuente": "nequi_sms",
  "confianza": 95,
  "fecha_original": null,
  "hora_original": null
}

IMPORTANTE:
- SIEMPRE responder SOLO con JSON válido
- NO agregar markdown (\`\`\`json)
- NO agregar explicaciones
- Monto SIEMPRE como número puro (sin formato)
`;

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemPrompt },
          { text: `Input to parse: "${text}"` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  };

  console.log('[Gemini] Processing:', text.substring(0, 50) + '...');

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        console.warn(`[Gemini] Rate limit exceeded (429). Attempt ${attempts}/${maxAttempts}`);
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s
          continue;
        } else {
          throw new Error("Rate limit exceeded after multiple retries");
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log('[Gemini] Full Response:', JSON.stringify(data, null, 2));

      const content = data.candidates[0].content.parts[0].text;
      
      // Clean up markdown if present (just in case)
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      const expense = JSON.parse(cleanContent);

      console.log('[Gemini] Response:', JSON.stringify(expense));

      // Post-parsing validation
      if (!expense.monto || expense.monto <= 0) {
        throw new Error("Invalid amount");
      }
      if (!expense.descripcion || expense.descripcion.trim() === '') {
        throw new Error("Missing description");
      }
      if (!expense.categoria) {
        throw new Error("Missing category");
      }

      // fecha_original and hora_original are optional


      return expense;

    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error("Request timed out after 30 seconds");
      }
      // If it's the last attempt or not a retryable error (unless it was 429 handled above)
      if (attempts === maxAttempts || (error.message && !error.message.includes("Rate limit"))) {
        console.error("[Gemini] Error parsing:", error);
        throw error;
      }
    }
  }
}

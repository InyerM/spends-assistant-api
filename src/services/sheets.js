
/**
 * Saves an expense to Google Sheets using native Web Crypto for authentication.
 * @param {Object} expense - The expense object.
 * @param {Object} env - The environment variables.
 * @returns {Promise<void>}
 */
export async function saveExpense(expense, env) {
  try {
    const credentialsJson = atob(env.GOOGLE_CREDENTIALS_JSON);
    const credentials = JSON.parse(credentialsJson);
    
    const accessToken = await getAccessToken(
      credentials.client_email,
      credentials.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const spreadsheetId = env.GOOGLE_SHEET_ID;

    // SIEMPRE obtener fecha/hora actual de Colombia
    const colombiaTimes = getCurrentColombiaTimes();
    let fecha = colombiaTimes.fecha;
    let hora = colombiaTimes.hora;

    // SOLO si viene fecha_original explícita del SMS, usarla
    if (expense.fecha_original && expense.hora_original) {
      console.log('[Sheets] Usando fecha explícita del SMS:', expense.fecha_original, expense.hora_original);
      
      // Convertir fecha del formato DD/MM/YYYY a YYYY-MM-DD
      const [day, month, year] = expense.fecha_original.split('/');
      fecha = `${year}-${month}-${day}`;
      hora = expense.hora_original;
    } else {
      console.log('[Sheets] Usando fecha/hora actual de Colombia:', fecha, hora);
    }

    // Format date for Sheets (DD/MM/YYYY)
    const fechaFormateada = formatDateForSheets(fecha);
    
    // Format time for Sheets (12h AM/PM)
    // If hora is HH:mm (from Gemini or previous getCurrentColombiaTimes), convert it.
    // If it is already formatted, keep it.
    const horaFormateada = formatTimeForSheets(hora);
    
    console.log('[Sheets] Fecha:', fechaFormateada, 'Hora:', horaFormateada);

    // Format values for the row
    const values = [[
      fechaFormateada,
      horaFormateada,
      expense.monto,
      capitalize(expense.descripcion),
      capitalize(expense.categoria),
      capitalize(expense.banco || 'otro'),
      capitalize(expense.tipo_pago || 'efectivo'),
      capitalize(expense.fuente || 'manual')
    ]];

    console.log('[Sheets] Guardando fila:', values[0]);

    // Update range to A:I to include the new column
    // Add insertDataOption=INSERT_ROWS to inherit formatting from the previous row
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Todos!A:I:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Sheets API Error: ${response.status} - ${errorText}`);
    }

    console.log('[Sheets] Guardado exitosamente');

  } catch (error) {
    console.error("[Sheets] Error saving:", error);
    throw error;
  }
}

// --- Helper Functions for Auth ---

async function getAccessToken(clientEmail, privateKey, scopes) {
  const jwt = await createSignedJWT(clientEmail, privateKey, scopes);
  
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token fetch failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function createSignedJWT(email, pemKey, scopes) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaim = base64UrlEncode(JSON.stringify(claim));
  const unsignedToken = `${encodedHeader}.${encodedClaim}`;

  const signature = await signWithPrivateKey(unsignedToken, pemKey);
  return `${unsignedToken}.${signature}`;
}

function base64UrlEncode(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function arrayBufferToBase64Url(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return base64UrlEncode(binary);
}

async function signWithPrivateKey(data, pemKey) {
  // 1. Parse PEM to binary
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pemKey
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");
  
  const binaryKey = str2ab(atob(pemContents));

  // 2. Import Key
  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  // 3. Sign
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );

  return arrayBufferToBase64Url(signature);
}

function str2ab(str) {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

/**
 * Converts ISO date string (YYYY-MM-DD) to Sheets format (DD/MM/YYYY).
 * @param {string} isoDate - Date string in YYYY-MM-DD format.
 * @returns {string} - Date string in DD/MM/YYYY format.
 */
export function formatDateForSheets(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Converts time to HH:mm:ss format.
 * Sends 24h time to Sheets so it is recognized as a valid Time value.
 * The Sheet's formatting (inherited via INSERT_ROWS) will handle the AM/PM display.
 * @param {string} time24 - Time in HH:mm or HH:mm:ss
 * @returns {string} - Time in HH:mm:ss
 */
function formatTimeForSheets(time24) {
  if (!time24) return '';
  
  // If it already has seconds, return as is
  if (time24.split(':').length === 3) return time24;

  // Append seconds if missing
  return `${time24}:00`;
}

/**
 * Capitalizes the first letter of a string.
 * @param {string} str 
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Gets current date and time in Colombia timezone (America/Bogota).
 * @returns {Object} - { fecha: "YYYY-MM-DD", hora: "HH:mm" }
 */
export function getCurrentColombiaTimes() {
  const now = new Date();
  
  // Convert to Colombia timezone (America/Bogota)
  const colombiaTime = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  const parts = {};
  colombiaTime.forEach(part => {
    parts[part.type] = part.value;
  });

  const fecha = `${parts.year}-${parts.month}-${parts.day}`;
  const hora = `${parts.hour}:${parts.minute}`;

  return { fecha, hora };
}

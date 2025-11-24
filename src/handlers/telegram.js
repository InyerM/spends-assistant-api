import { Telegraf } from 'telegraf';
import { parseExpense } from '../parsers/gemini.js';
import { saveExpense, formatDateForSheets, getCurrentColombiaTimes } from '../services/sheets.js';

/**
 * Handles Telegram updates.
 * @param {Request} request - The incoming request.
 * @param {Object} env - The environment variables.
 * @returns {Promise<Response>}
 */
export async function handleTelegram(request, env) {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // Middleware to handle errors
  bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx.updateType}`, err);
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    
    // Quick validation for Nequi SMS forwarding
    if (text.includes("Nequi") && !text.includes("85954") && !ctx.message.forward_from) {
      // Optional: Add stricter checks if needed
    }

    try {
      // 1. Parse with Gemini
      ctx.replyWithChatAction('typing');
      const expense = await parseExpense(text, env.GEMINI_API_KEY);

      // 2. Save to Sheets
      await saveExpense(expense, env);

      // 3. Reply with confirmation
      
      // Determinar qué fecha/hora se usó
      const colombiaTimes = getCurrentColombiaTimes();
      let fechaMostrar = colombiaTimes.fecha;
      let horaMostrar = colombiaTimes.hora;

      if (expense.fecha_original && expense.hora_original) {
        const [day, month, year] = expense.fecha_original.split('/');
        fechaMostrar = `${year}-${month}-${day}`;
        horaMostrar = expense.hora_original;
      }

      const fechaFormateada = formatDateForSheets(fechaMostrar);

      const confirmationMessage = `✅ Gasto registrado

💰 $${expense.monto.toLocaleString('es-CO')}
🏪 ${expense.descripcion}
📅 ${fechaFormateada} ${horaMostrar}
🏷️ ${expense.categoria}
💳 ${expense.banco} - ${expense.tipo_pago}

🔗 [View Sheet](${env.GOOGLE_SHEET_URL})`;
      
      await ctx.reply(confirmationMessage, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error("Processing error:", error);
      
      let errorMessage = `
❌ Could not process expense

Try format:
"20000 in rappi"
"bought 50k groceries"

Or forward the SMS/email as is.
Error: ${error.message}
      `;

      if (error.message.includes("Rate limit")) {
        errorMessage = "⏳ El servicio está muy ocupado. Por favor intenta en 30 segundos.";
      } else if (error.message.includes("timed out")) {
        errorMessage = "⏱️ La solicitud tardó demasiado. Por favor intenta de nuevo.";
      } else if (error.message.includes("Google Sheets API Error")) {
        errorMessage = "❌ Error guardando en Google Sheets. Por favor contacta al administrador.";
      } else if (error.message.includes("Invalid amount") || error.message.includes("Missing description")) {
        errorMessage = `
❌ No pude entender el mensaje. Intenta con formato:
• '20000 en rappi'
• '50mil de almuerzo'
• O reenvía el SMS bancario completo
        `;
      }

      await ctx.reply(errorMessage);
    }
  });

  // Handle the update
  try {
    const body = await request.json();
    await bot.handleUpdate(body);
    return new Response('OK');
  } catch (e) {
    console.error("Error handling update:", e);
    return new Response('Error', { status: 500 });
  }
}

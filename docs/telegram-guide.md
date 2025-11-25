# Telegram Bot Setup Guide

## Quick Start

1. **Find Your Bot**
   - Open Telegram
   - Search for your bot username (the one you created with @BotFather)
   - Start a conversation

2. **That's it!** The bot is already configured and ready to use.

## How to Use

### Method 1: Natural Language (Easiest)
Just type your expense naturally:
```
20k almuerzo
50mil en rappi
bought 100k groceries
```

### Method 2: Commands
Use explicit commands:
```
/gasto 20k almuerzo
/expense 50k uber
```

### Method 3: Forward Bank SMS
Simply forward messages from:
- Bancolombia
- Nequi
- Other bank notifications

## Available Commands

- `/start` - Welcome message and quick guide
- `/help` - Detailed instructions
- `/gasto <amount> <description>` - Register expense (Spanish)
- `/expense <amount> <description>` - Register expense (English)

## Examples

**Good formats:**
```
20k cafe
50mil rappi
/gasto 100000 mercado
/expense 25k uber
```

**Bank SMS (just forward):**
```
Bancolombia: Compraste $11.000 en DLO*GOOGLE 
con tu T.Deb *7799, el 23/11/2024 a las 21:02
```

## Configuration in @BotFather (Optional)

If you want to set up bot commands menu in Telegram:

1. Open @BotFather
2. Send `/setcommands`
3. Select your bot
4. Paste this:
```
start - Welcome message
help - Show help and examples
gasto - Register expense
expense - Register expense
```

This will show command suggestions when users type `/` in your bot.

## Tips

- The bot understands both Spanish and English
- It automatically detects the category (food, transport, etc.)
- It identifies your bank from SMS messages
- Duplicate messages are cached (won't create duplicates)
- Works offline-first: processes even if you're not connected

## Troubleshooting

**Bot doesn't respond?**
- Make sure you started the conversation (click "Start" button)
- Check bot is deployed and running

**"Could not process expense"?**
- Try simpler format: `20000 almuerzo`
- Or use command: `/gasto 20000 almuerzo`
- Or forward bank SMS directly

**Want to see more?**
- Check your dashboard (link in confirmation message)
- View transaction history

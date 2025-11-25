import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { createSupabaseServices } from '../src/services/supabase';
import { CreateTransactionInput } from '../src/types/transaction';
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_SERVICE_KEY in .env.local');
  process.exit(1);
}

const services = createSupabaseServices(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function importCSV(csvPath: string) {
  try {
    console.log(`Reading file: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true
    });
    
    console.log(`Found ${records.length} records`);
    console.log(`Starting import...`);
    
    let successCount = 0;
    let failCount = 0;

    for (const record of records) {
      try {
        const amount = Math.abs(parseFloat(record.Amount));
        const dateObj = new Date(record.Date);
        const date = dateObj.toISOString().split('T')[0];
        const time = '12:00:00';

        const categoryName = mapCategory(record.Category);
        const category = await services.categories.getCategory(categoryName);
        const categoryId = category ? category.id : undefined;

        const accountName = mapAccount(record.Account);
        const account = await services.accounts.getAccount(accountName);
        const accountId = account ? account.id : '00000000-0000-0000-0000-000000000000';

        let description = record.Note || record.Category;
        if (record.Labels) {
          description += ` (${record.Labels})`;
        }

        const transaction: CreateTransactionInput = {
          date,
          time,
          amount,
          description: capitalize(description),
          category_id: categoryId,
          account_id: accountId,
          type: 'expense',
          payment_method: 'cash',
          source: 'import_csv',
          confidence: 100,
          raw_text: JSON.stringify(record)
        };

        await services.transactions.createTransaction(transaction, services.accounts);
        successCount++;
        
        if (successCount % 50 === 0) {
          console.log(`Imported ${successCount}/${records.length}`);
        }

      } catch (err) {
        console.error(`Error importing record:`, record, err);
        failCount++;
      }
    }
    
    console.log(`Import completed. Success: ${successCount}, Failed: ${failCount}`);
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

function mapCategory(budgetBakersCategory: string): string {
  const mapping: Record<string, string> = {
    'Food & Drink': 'food',
    'Restaurants': 'food',
    'Groceries': 'food',
    'Transport': 'transportation',
    'Shopping': 'shopping',
    'Entertainment': 'entertainment',
    'Health': 'health',
    'Bills & Utilities': 'utilities',
    'Education': 'education',
    'Home': 'home',
    'Rent': 'home',
    'Salary': 'salary',
    'Fitness': 'health',
    'Travel': 'other'
  };
  
  return mapping[budgetBakersCategory] || 'other';
}

function mapAccount(accountName: string): string {
  const lower = accountName.toLowerCase();
  if (lower.includes('bancolombia')) return 'bancolombia';
  if (lower.includes('nequi')) return 'nequi';
  if (lower.includes('cash') || lower.includes('efectivo')) return 'cash';
  return 'bancolombia';
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: npx ts-node scripts/import-csv.ts <csv-path>');
  process.exit(1);
}

importCSV(csvPath);

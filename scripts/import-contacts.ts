import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const csvFile = process.argv[2];

if (!csvFile) {
  console.error('Usage: npx ts-node scripts/import-contacts.ts <csv-file>');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

interface Contact {
  email: string;
  name: string;
  title: string | null;
  company_name: string | null;
  is_emails_enriched: boolean;
}

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

async function importContacts(filePath: string) {
  console.log(`Reading ${filePath}...`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCSV(content);
  console.log(`Found ${rows.length} rows in CSV`);

  // Supports both Apollo exports (Email, First Name, Last Name, Title, Company Name)
  // and Hunter exports (Email address, First name, Last name, Job title, Company).
  const getEmail = (row: Record<string, string>) => row['Email'] || row['Email address'] || '';
  const getFirstName = (row: Record<string, string>) => row['First Name'] || row['First name'] || '';
  const getLastName = (row: Record<string, string>) => row['Last Name'] || row['Last name'] || '';
  const getTitle = (row: Record<string, string>) => row['Title'] || row['Job title'] || null;
  const getCompany = (row: Record<string, string>) => row['Company Name'] || row['Company'] || null;

  const rawContacts: Contact[] = rows
    .filter(row => getEmail(row) && getEmail(row).includes('@'))
    .map(row => ({
      email: getEmail(row).toLowerCase(),
      name: `${getFirstName(row)} ${getLastName(row)}`.trim(),
      title: getTitle(row),
      company_name: getCompany(row),
      is_emails_enriched: false,
    }));

  // Dedupe within-CSV (Apollo exports sometimes duplicate emails)
  const seen = new Set<string>();
  const csvContacts: Contact[] = rawContacts.filter(c => {
    if (seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
  if (rawContacts.length !== csvContacts.length) {
    console.log(`Dedupe: ${rawContacts.length - csvContacts.length} duplicate email(s) within CSV`);
  }

  if (csvContacts.length === 0) {
    console.log('No valid contacts found in CSV');
    return;
  }

  const emails = csvContacts.map(c => c.email);

  // Supabase/PostgREST rejects .in() queries once the URL exceeds ~16KB of
  // headers, which silently fails (error swallowed below) for CSVs with
  // hundreds of rows — the exact case that let already-archived/bounced
  // contacts slip back in undetected. Chunk every .in() lookup to stay safe.
  const CHUNK_SIZE = 150;
  function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function fetchChunked<T>(
    label: string,
    table: string,
    columns: string
  ): Promise<T[]> {
    const results: T[] = [];
    for (const batch of chunk(emails, CHUNK_SIZE)) {
      const { data, error } = await supabase.from(table).select(columns).in('email', batch);
      if (error) {
        console.error(`\nError checking ${label} (aborting import to avoid re-sending to bounced/archived contacts): ${error.message}`);
        process.exit(1);
      }
      results.push(...((data || []) as T[]));
    }
    return results;
  }

  const [existingRows, trackingRows, archivedRows, bouncedRows] = await Promise.all([
    fetchChunked<{ email: string; is_emails_enriched: boolean }>('contacts', 'contacts', 'email, is_emails_enriched'),
    fetchChunked<{ email: string; status: string }>('email_tracking', 'email_tracking', 'email, status'),
    fetchChunked<{ email: string }>('archived_contacts', 'archived_contacts', 'email'),
    fetchChunked<{ email: string }>('bounced_emails', 'bounced_emails', 'email'),
  ]);

  const existingMap = new Map(existingRows.map((r) => [r.email, r.is_emails_enriched]));
  const trackingMap = new Map(trackingRows.map((r) => [r.email, r.status]));
  const archivedSet = new Set(archivedRows.map((r) => r.email));
  const bouncedSet = new Set(bouncedRows.map((r) => r.email));

  const toImport: Contact[] = [];
  const alreadySent: string[] = [];
  const pendingGeneration: string[] = [];
  const archived: string[] = [];
  const bounced: string[] = [];

  for (const contact of csvContacts) {
    if (bouncedSet.has(contact.email)) {
      bounced.push(`  ${contact.name} (${contact.email}) — permanently bounced, skipped`);
      continue;
    }

    if (archivedSet.has(contact.email)) {
      archived.push(`  ${contact.name} (${contact.email}) — archived/unsubscribed`);
      continue;
    }

    const trackingStatus = trackingMap.get(contact.email);
    if (trackingStatus && trackingStatus !== 'pending') {
      // Has a real tracking record — initial email was sent
      alreadySent.push(`  ${contact.name} (${contact.email}) — status: ${trackingStatus}`);
      continue;
    }

    if (existingMap.has(contact.email)) {
      // In contacts table but no sent tracking record
      pendingGeneration.push(`  ${contact.name} (${contact.email}) — already in DB, awaiting generation/send`);
      continue;
    }

    toImport.push(contact);
  }

  // Report skipped contacts
  if (alreadySent.length > 0) {
    console.log(`\nSkipped — initial email already sent (${alreadySent.length}):`);
    alreadySent.forEach(l => console.log(l));
  }

  if (pendingGeneration.length > 0) {
    console.log(`\nSkipped — already in DB, not yet sent (${pendingGeneration.length}):`);
    pendingGeneration.forEach(l => console.log(l));
  }

  if (archived.length > 0) {
    console.log(`\nSkipped — archived/unsubscribed (${archived.length}):`);
    archived.forEach(l => console.log(l));
  }

  if (bounced.length > 0) {
    console.log(`\nSkipped — permanently bounced (${bounced.length}):`);
    bounced.forEach(l => console.log(l));
  }

  if (toImport.length === 0) {
    console.log('\nNo new contacts to import.');
    return;
  }

  console.log(`\nNew contacts to import (${toImport.length}):`);
  toImport.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name} (${c.email}) — ${c.title} @ ${c.company_name}`);
  });

  const { data, error } = await supabase
    .from('contacts')
    .upsert(toImport, { onConflict: 'email', ignoreDuplicates: true })
    .select('email');

  if (error) {
    console.error('\nError importing:', error.message);
    process.exit(1);
  }

  console.log(`\nSuccessfully imported ${data?.length || 0} new contacts`);
}

importContacts(csvFile);

import { getSupabaseClient } from './supabase';
import { Contact, GeneratedEmails } from '../types';

interface SupabaseContact {
  email: string;
  name: string;
  title: string | null;
  company_name: string | null;
  is_emails_enriched: boolean;
  initial_email_subject: string | null;
  initial_email: string | null;
  follow_up_1_subject: string | null;
  follow_up_1: string | null;
  follow_up_2_subject: string | null;
  follow_up_2: string | null;
  follow_up_3_subject: string | null;
  follow_up_3: string | null;
  research_summary: string | null;
  resume_type: string | null;
  created_at: string;
  updated_at: string;
}

function toContact(row: SupabaseContact): Contact {
  return {
    email: row.email.toLowerCase(),
    name: row.name,
    title: row.title || undefined,
    company_name: row.company_name || undefined,
    is_emails_enriched: row.is_emails_enriched,
    initial_email_subject: row.initial_email_subject || undefined,
    initial_email: row.initial_email || undefined,
    follow_up_1_subject: row.follow_up_1_subject || undefined,
    follow_up_1: row.follow_up_1 || undefined,
    follow_up_2_subject: row.follow_up_2_subject || undefined,
    follow_up_2: row.follow_up_2 || undefined,
    follow_up_3_subject: row.follow_up_3_subject || undefined,
    follow_up_3: row.follow_up_3 || undefined,
    research_summary: row.research_summary || undefined,
    resume_type: row.resume_type || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Get all contacts
export async function getContacts(): Promise<Contact[]> {
  const supabase = getSupabaseClient();

  console.log('Querying contacts table...');

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .order('created_at', { ascending: true });

  console.log('Query result - data:', data?.length ?? 0, 'rows, error:', error?.message ?? 'none');

  if (error) {
    throw new Error(`Failed to fetch contacts: ${error.message}`);
  }

  if (!data || data.length === 0) {
    console.log('No contacts found in database');
    return [];
  }

  const contacts = data.map((row: SupabaseContact) => toContact(row));
  console.log(`Loaded ${contacts.length} contacts from Supabase`);
  return contacts;
}

// Get contacts that need email generation
export async function getUnenrichedContacts(): Promise<Contact[]> {
  const supabase = getSupabaseClient();

  console.log('Querying unenriched contacts...');

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('is_emails_enriched', false)
    .order('created_at', { ascending: true });

  console.log('Query result - data:', data?.length ?? 0, 'unenriched contacts');

  if (error) {
    throw new Error(`Failed to fetch unenriched contacts: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row: SupabaseContact) => toContact(row));
}

// Get contacts with emails ready to send
export async function getEnrichedContacts(): Promise<Contact[]> {
  const supabase = getSupabaseClient();

  console.log('Querying enriched contacts...');

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('is_emails_enriched', true)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch enriched contacts: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row: SupabaseContact) => toContact(row));
}

// Get a single contact by email
export async function getContactByEmail(email: string): Promise<Contact | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch contact: ${error.message}`);
  }

  if (!data) return null;

  return toContact(data as SupabaseContact);
}

// Update contact with generated emails
export async function updateContactEmails(
  email: string,
  emails: GeneratedEmails
): Promise<Contact> {
  const supabase = getSupabaseClient();

  const updateData = {
    initial_email_subject: emails.initial_email_subject,
    initial_email: emails.initial_email,
    follow_up_1_subject: emails.follow_up_1_subject,
    follow_up_1: emails.follow_up_1,
    follow_up_2_subject: emails.follow_up_2_subject,
    follow_up_2: emails.follow_up_2,
    follow_up_3_subject: emails.follow_up_3_subject,
    follow_up_3: emails.follow_up_3,
    research_summary: emails.research_summary || null,
    resume_type: emails.resume_type || 'data_scientist',
    is_emails_enriched: true,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('contacts')
    .update(updateData)
    .eq('email', email.toLowerCase())
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update contact emails: ${error.message}`);
  }

  return toContact(data as SupabaseContact);
}

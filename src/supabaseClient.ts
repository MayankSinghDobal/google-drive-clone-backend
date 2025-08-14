import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://wjdapshounbzdsnoohoy.supabase.co' ; // Replace with your Supabase Project URL
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndqZGFwc2hvdW5iemRzbm9vaG95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwOTMxNTEsImV4cCI6MjA3MDY2OTE1MX0.2SNf1bxllZsOakw4xDzZ1YYiS-Bik4rICQ8RNef9zvM' ; // Replace with your Supabase Anon Key

export const supabase = createClient(supabaseUrl, supabaseKey);
import { Global, Module } from '@nestjs/common';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedClient;
}

@Global()
@Module({
  providers: [
    {
      provide: SupabaseClient,
      useFactory: () => getSupabaseClient(),
    },
  ],
  exports: [SupabaseClient],
})
export class SupabaseModule {}

import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SupabaseClient } from '@supabase/supabase-js';
import { seedDatabase } from '@perc/shared';
import { SupabaseModule } from './supabase/supabase.module';
import { MeetingController } from './webhooks/meeting.controller';
import { EngineModule } from './webhooks/engine.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    EventEmitterModule.forRoot(),
    SupabaseModule,
    EngineModule,
  ],
  controllers: [
    MeetingController,
  ],
  providers: [],
})
export class MeetingServiceModule implements OnModuleInit {
  constructor(private supabase: SupabaseClient) {}

  async onModuleInit() {
    await seedDatabase(this.supabase);
  }
}

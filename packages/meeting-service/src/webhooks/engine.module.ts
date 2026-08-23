import { Module } from '@nestjs/common';
import { MeetingService } from './meeting.service';
import { MeetingRequestedListener } from './listeners/meeting-requested.listener';

@Module({
  providers: [
    MeetingService,
    MeetingRequestedListener,
  ],
  exports: [MeetingService],
})
export class EngineModule {}

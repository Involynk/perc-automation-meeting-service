import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LeadCapturedEvent, TRIGGER_MEETING_REQUESTED } from '@perc/shared';
import { MeetingService } from '../meeting.service';

@Injectable()
export class MeetingRequestedListener {
  private readonly logger = new Logger(MeetingRequestedListener.name);

  constructor(
    private meetingService: MeetingService,
  ) {}

  @OnEvent('lead.captured')
  async handle(event: LeadCapturedEvent): Promise<void> {
    if (event.triggerEvent !== TRIGGER_MEETING_REQUESTED) return;

    const meetingType = (event as any).metadata?.meetingType || 'meeting';

    this.logger.log(
      `Meeting requested for lead ${event.leadId} (${meetingType}) — offering slots`,
    );

    await this.meetingService.handleMeetingRequest(event.leadId, event.source, {
      meetingType,
      rawUserMessage: event.message,
    });
  }
}

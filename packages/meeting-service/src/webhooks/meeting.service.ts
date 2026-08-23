import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  TRIGGER_MEETING_REQUESTED,
  TRIGGER_MEETING_CONFIRMED,
  MeetingSlot,
  MeetingScheduledEvent,
} from '@perc/shared';
import * as crypto from 'crypto';

interface CalendarSettings {
  start: string;
  end: string;
  timezone: string;
  durationMinutes?: number;
  bufferMinutes?: number;
}

interface MeetingIntent {
  meetingType: string;
  rawUserMessage?: string;
}

@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private supabase: SupabaseClient,
    private eventEmitter: EventEmitter2,
  ) {}

  // ── Intent entry point (consumed from lead.captured / meeting.requested) ──
  async handleMeetingRequest(leadId: string, source: string, intent: MeetingIntent): Promise<void> {
    const { data: lead } = await this.supabase.from('leads').select('*').eq('id', leadId).single();
    if (!lead) return;

    const organizerId = lead.assigned_to || (await this.findDefaultOrganizer());
    const slots = await this.findAvailableSlots(organizerId, 3);

    if (slots.length === 0) {
      this.logger.warn(`No available slots for lead ${leadId}`);
      await this.emitResponse(lead, source, TRIGGER_MEETING_REQUESTED, {
        meeting_type: intent.meetingType,
        slot_options: 'tomorrow morning',
      });
      return;
    }

    await this.supabase.from('meetings').insert({
      id: crypto.randomUUID(),
      lead_id: leadId,
      organizer_id: organizerId,
      meeting_type: intent.meetingType,
      status: 'scheduled',
      scheduled_at: null,
      duration_minutes: 30,
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await this.supabase.from('timeline_events').insert({
      id: crypto.randomUUID(),
      lead_id: leadId,
      event_type_id: 'evt_meeting_requested',
      actor_type: 'automation',
      description: `${lead.first_name || 'Lead'} requested a ${intent.meetingType}`,
      metadata: JSON.stringify({ meeting_type: intent.meetingType, slots }),
    });

    await this.emitResponse(lead, source, TRIGGER_MEETING_REQUESTED, {
      meeting_type: intent.meetingType,
      slot_options: this.formatSlotOptions(slots),
      meeting_slots: slots,
    });
  }

  // ── Availability ──
  async findAvailableSlots(organizerId: string | null, count: number): Promise<MeetingSlot[]> {
    const settings = await this.loadCalendarSettings();
    const duration = Number(settings.durationMinutes) || 30;
    const buffer = Number(settings.bufferMinutes) || 15;

    const { data: existing } = await this.supabase
      .from('meetings')
      .select('scheduled_at, duration_minutes')
      .eq('status', 'scheduled')
      .not('scheduled_at', 'is', null);

    const busy: Array<{ start: number; end: number }> = (existing || [])
      .filter((m: any) => !organizerId || !m.organizer_id || m.organizer_id === organizerId)
      .map((m: any) => ({
        start: new Date(m.scheduled_at).getTime(),
        end: new Date(m.scheduled_at).getTime() + (m.duration_minutes || duration) * 60000,
      }));

    const slots: MeetingSlot[] = [];
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    for (let day = 0; day < 7 && slots.length < count; day++) {
      const cursor = new Date(startOfDay.getTime() + day * 86400000);
      if (cursor.getDay() === 0) continue;

      const slotStart = new Date(cursor);
      slotStart.setHours(parseInt(settings.start.split(':')[0]), parseInt(settings.start.split(':')[1] || '0'), 0, 0);
      const slotEndBoundary = new Date(cursor);
      slotEndBoundary.setHours(parseInt(settings.end.split(':')[0]), parseInt(settings.end.split(':')[1] || '0'), 0, 0);

      while (slotStart.getTime() + duration * 60000 <= slotEndBoundary.getTime() && slots.length < count) {
        const startTs = slotStart.getTime();
        const endTs = startTs + duration * 60000;
        const startTz = new Date(startTs + buffer * 60000);
        const endTz = new Date(endTs + buffer * 60000);

        const isBusy = busy.some((b) => startTz.getTime() < b.end && endTz.getTime() > b.start);
        const isPast = startTz.getTime() < now;

        if (!isBusy && !isPast) {
          slots.push({
            start: new Date(startTz).toISOString(),
            end: new Date(endTz).toISOString(),
            label: this.formatSlotLabel(new Date(startTz)),
          });
        }

        slotStart.setMinutes(slotStart.getMinutes() + duration + buffer);
      }
    }

    return slots;
  }

  // ── Booking (Meeting Creation & Link Generation) ──
  async bookMeeting(
    leadId: string,
    scheduledAt: string,
    meetingType: string,
    organizerId?: string,
  ): Promise<{ meetingId: string; leadId: string }> {
    const { data: lead } = await this.supabase.from('leads').select('*').eq('id', leadId).single();
    if (!lead) throw new Error('Lead not found');

    const meetingId = crypto.randomUUID();
    const orgId = organizerId || lead.assigned_to || (await this.findDefaultOrganizer());
    const meetingLink = await this.generateMeetingLink(meetingId, orgId);

    await this.supabase.from('meetings').insert({
      id: meetingId,
      lead_id: leadId,
      organizer_id: orgId,
      meeting_type: meetingType,
      status: 'scheduled',
      scheduled_at: scheduledAt,
      duration_minutes: Number(process.env.DEFAULT_MEETING_DURATION_MINUTES) || 30,
      metadata: JSON.stringify({ meeting_link: meetingLink }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await this.updateLeadStatus(lead, meetingType === 'demo' ? 'demo_scheduled' : 'call_scheduled');

    await this.supabase.from('timeline_events').insert({
      id: crypto.randomUUID(),
      lead_id: leadId,
      event_type_id: 'evt_meeting_scheduled',
      actor_type: 'automation',
      description: `${meetingType} booked for ${new Date(scheduledAt).toISOString()}`,
      metadata: JSON.stringify({ meeting_id: meetingId, scheduled_at: scheduledAt, meeting_link: meetingLink }),
    });

    // Emits meeting.scheduled domain event so scheduler-service and notification-service react
    this.eventEmitter.emit(
      'meeting.scheduled',
      new MeetingScheduledEvent(meetingId, leadId, scheduledAt, meetingType, orgId),
    );

    await this.emitResponse(lead, lead.source, TRIGGER_MEETING_CONFIRMED, {
      meeting_id: meetingId,
      meeting_type: meetingType,
      meeting_time: this.formatDateTime(new Date(scheduledAt)),
      meeting_link: meetingLink,
      organizer_name: await this.findOrganizerName(orgId),
    });

    return { meetingId, leadId };
  }

  // ── Helper Methods ──
  private async updateLeadStatus(lead: any, newStatus: string): Promise<void> {
    try {
      await this.supabase
        .from('leads')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', lead.id);
    } catch (err: any) {
      this.logger.warn(`Failed to update lead status: ${err.message}`);
    }
  }

  private async emitResponse(lead: any, channel: string, triggerEvent: string, templateVars: Record<string, any>): Promise<void> {
    try {
      this.eventEmitter.emit(
        'response.generated',
        {
          leadId: lead.id,
          channel,
          triggerEvent,
          templateVars,
        },
      );
    } catch (err: any) {
      this.logger.error(`Failed to emit response event: ${err.message}`);
    }
  }

  private async loadCalendarSettings(): Promise<CalendarSettings> {
    const settings: CalendarSettings = {
      start: '09:00',
      end: '18:00',
      timezone: 'Asia/Kolkata',
    };

    let durationMinutes = 30;
    let bufferMinutes = 15;

    try {
      const { data } = await this.supabase
        .from('settings')
        .select('key, value')
        .in('key', ['calendar_start_time', 'calendar_end_time', 'meeting_duration_minutes', 'buffer_between_meetings_minutes']);

      if (data) {
        for (const row of data) {
          if (row.key === 'calendar_start_time') settings.start = row.value;
          if (row.key === 'calendar_end_time') settings.end = row.value;
          if (row.key === 'meeting_duration_minutes') durationMinutes = parseInt(row.value) || 30;
          if (row.key === 'buffer_between_meetings_minutes') bufferMinutes = parseInt(row.value) || 15;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to load calendar settings: ${err.message}`);
    }

    return { ...settings, durationMinutes, bufferMinutes };
  }

  private async findDefaultOrganizer(): Promise<string | null> {
    const defaultId = process.env.DEFAULT_ORGANIZER_ID;
    if (defaultId) return defaultId;

    const roles = (process.env.DEFAULT_ORGANIZER_ROLES || 'super_admin,admin,counselor').split(',');
    const { data } = await this.supabase
      .from('users')
      .select('id')
      .in('role', roles)
      .eq('is_active', true)
      .limit(1);
    return data?.[0]?.id || null;
  }

  // ── 100% Free Meeting Link Generation Engine ──
  private async generateMeetingLink(meetingId: string, orgId: string | null): Promise<string> {
    if (orgId) {
      const { data: user } = await this.supabase.from('users').select('meeting_link').eq('id', orgId).maybeSingle();
      if (user?.meeting_link) return user.meeting_link;
    }

    const provider = (process.env.MEETING_PROVIDER || 'jitsi').toLowerCase();

    if (provider === 'gmeet' && process.env.DEFAULT_GMEET_ROOM_URL) {
      return process.env.DEFAULT_GMEET_ROOM_URL;
    }

    const roomName = `PERC-${meetingId.slice(0, 8)}-${Date.now().toString(36)}`;
    const jitsiDomain = process.env.JITSI_DOMAIN || 'meet.jit.si';
    return `https://${jitsiDomain}/${roomName}`;
  }

  private async findOrganizerName(organizerId: string | null): Promise<string> {
    if (!organizerId) return 'our team';
    try {
      const { data } = await this.supabase.from('users').select('name').eq('id', organizerId).maybeSingle();
      return data?.name || 'our team';
    } catch {
      return 'our team';
    }
  }

  private formatSlotOptions(slots: MeetingSlot[]): string {
    return slots.map((s, i) => `${i + 1}. ${s.label}`).join('\n');
  }

  private formatSlotLabel(d: Date): string {
    return d.toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    });
  }

  private formatDateTime(d: Date): string {
    return d.toLocaleString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: 'numeric', minute: '2-digit',
    });
  }
}

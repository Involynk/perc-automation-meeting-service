import { Controller, Get, Post, Param, Body, Query, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { MeetingService } from './meeting.service';

@Controller('api/meetings')
export class MeetingController {
  constructor(
    private supabase: SupabaseClient,
    private meetingService: MeetingService,
  ) {}

  @Get('slots')
  async availableSlots(@Query('organizer_id') organizerId?: string, @Query('count') count?: string) {
    const slots = await this.meetingService.findAvailableSlots(organizerId || null, parseInt(count || '3'));
    return { slots };
  }

  @Get()
  async listMeetings(@Query('lead_id') leadId?: string, @Query('status') status?: string) {
    let query = this.supabase.from('meetings').select('*').order('scheduled_at', { ascending: true }).limit(100);
    if (leadId) query = query.eq('lead_id', leadId);
    if (status) query = query.eq('status', status);
    const { data } = await query;
    return data || [];
  }

  @Get(':id')
  async getMeeting(@Param('id') id: string) {
    const { data: meeting } = await this.supabase.from('meetings').select('*').eq('id', id).single();
    if (!meeting) throw new HttpException('Meeting not found', HttpStatus.NOT_FOUND);
    return meeting;
  }

  @Post()
  async bookMeeting(@Body() body: any) {
    if (!body.lead_id || !body.scheduled_at) {
      throw new HttpException('lead_id and scheduled_at are required', HttpStatus.BAD_REQUEST);
    }
    const result = await this.meetingService.bookMeeting(
      body.lead_id,
      body.scheduled_at,
      body.meeting_type || 'call',
      body.organizer_id,
    );
    return { status: 'success', meeting_id: result.meetingId, lead_id: result.leadId };
  }
}

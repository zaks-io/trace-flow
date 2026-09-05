'use node';

import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import { InviteEmail } from '@trace-flow/emails';
import { WaitlistConfirmationEmail } from '@trace-flow/emails';

const INVITE_EXPIRY_DAYS = 7;
const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Trace Flow <noreply@updates.trace-flow.dev>';
const APP_URL = process.env.APP_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';

export const sendWaitlistAdminEmail = internalAction({
  args: { waitlistId: v.id('waitlist'), email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const emails = await ctx.runQuery(internal.waitlist.getAdminEmails, {});
    if (emails.length === 0) throw new Error('No enabled admins to notify about waitlist signup');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const failures: unknown[] = [];
    for (const email of emails) {
      try {
        const { error } = await resend.emails.send(
          {
            from: EMAIL_FROM,
            to: email,
            subject: 'Confirmed Trace Flow waitlist signup',
            text: `${args.email} confirmed their email address and is ready to invite from the Trace Flow waitlist.\n\nManage the waitlist: ${APP_URL}/app/admin/invites`,
          },
          { idempotencyKey: `waitlist-confirmed/${args.waitlistId}/${email}` },
        );
        if (error) throw new Error(`Waitlist admin email failed: ${error.name}`);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Waitlist admin email delivery failed');
    return null;
  },
});

export const sendInviteEmail = internalAction({
  args: {
    email: v.string(),
    token: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const inviteUrl = `${APP_URL}/invite/${args.token}`;

    const html = await render(InviteEmail({ inviteUrl, expiresInDays: INVITE_EXPIRY_DAYS }));

    await resend.emails.send({
      from: EMAIL_FROM,
      to: args.email,
      subject: "You've been invited to Trace Flow",
      html,
    });

    return null;
  },
});

export const sendConfirmationEmail = internalAction({
  args: {
    email: v.string(),
    confirmationToken: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const confirmUrl = `${APP_URL}/waitlist/confirm/${args.confirmationToken}`;

    const html = await render(WaitlistConfirmationEmail({ confirmUrl }));

    await resend.emails.send({
      from: EMAIL_FROM,
      to: args.email,
      subject: 'Confirm your Trace Flow waitlist spot',
      html,
    });

    return null;
  },
});

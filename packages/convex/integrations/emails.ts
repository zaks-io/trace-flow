'use node';

import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import { InviteEmail } from '@trace-flow/emails';
import { WaitlistConfirmationEmail } from '@trace-flow/emails';

const INVITE_EXPIRY_DAYS = 7;
const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Trace Flow <noreply@updates.trace-flow.dev>';
const APP_URL = process.env.APP_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';

async function emailAdmins(
  ctx: ActionCtx,
  message: { subject: string; text: string; idempotencyKey: string },
) {
  const admins = await ctx.runQuery(internal.auth.users.getAdminEmails, {});
  if (admins.length === 0) throw new Error(`No enabled admins to email: ${message.subject}`);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const failures: unknown[] = [];
  // One send per admin so a rejected address cannot block the others, and retries
  // stay idempotent per recipient.
  for (const to of admins) {
    try {
      const { error } = await resend.emails.send(
        { from: EMAIL_FROM, to, subject: message.subject, text: message.text },
        { idempotencyKey: `${message.idempotencyKey}/${to}` },
      );
      if (error) throw new Error(`Resend rejected admin email: ${error.name}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Admin email delivery failed: ${message.subject}`);
  }
}

export const sendWaitlistAdminEmail = internalAction({
  args: { waitlistId: v.id('waitlist'), email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await emailAdmins(ctx, {
      subject: 'Confirmed Trace Flow waitlist signup',
      text: `${args.email} confirmed their email address and is ready to invite from the Trace Flow waitlist.\n\nManage the waitlist: ${APP_URL}/app/admin/invites`,
      idempotencyKey: `waitlist-confirmed/${args.waitlistId}`,
    });
    return null;
  },
});

export const sendSignupAdminEmail = internalAction({
  args: {
    userId: v.id('users'),
    email: v.string(),
    emailVerified: v.boolean(),
    name: v.optional(v.string()),
    invited: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const who = args.name ? `${args.name} <${args.email}>` : args.email;
    const via = args.invited ? 'from an invite' : 'through open sign-up';
    const verification = args.emailVerified ? '' : ' Their email address is not verified yet.';
    await emailAdmins(ctx, {
      subject: `New Trace Flow sign-up: ${args.email}`,
      text: `${who} created a Trace Flow account ${via}.${verification}`,
      idempotencyKey: `user-signup/${args.userId}`,
    });
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

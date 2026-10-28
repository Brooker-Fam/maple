export type WaitlistEmailReason =
  | "already_signed_up"
  | "already_sent"
  | "send_pending"
  | "delivery_unknown"
  | "email_unavailable"
  | "signup_closed";

/** The address is only available through the separately authorized reveal action. */
export type AdminWaitlistPreview = {
  subject: string;
  text: string;
  from: string;
  replyTo: string;
  toMasked: string;
  sendToken: string | null;
  canSend: boolean;
  reason: WaitlistEmailReason | null;
  sentAt: string | null;
};

/** "sent" means Resend accepted the email, not that the inbox received it. */
export type AdminWaitlistSendResult = {
  status: "sent" | "already_sent" | "send_pending" | "delivery_unknown";
  sentAt: string | null;
};

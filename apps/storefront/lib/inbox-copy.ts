import type { InboxReplyTime } from '@storeplix/types';
import type { Localized } from './checkout-guard';

/**
 * Shopper-facing copy for the chat widget and order Messages (PHASE-8-8E §9.3, §10; Figma 2125:9509–2126:10642).
 * `{ en, bn }` like the checkout guard: the storefront has no store-language setting yet, so the theme renders `en`
 * and the Bangla line is ready for when it does.
 */
export type Lang = keyof Localized;
export const DEFAULT_LANG: Lang = 'en';

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnDigits = (s: string | number) => String(s).replace(/\d/g, (d) => BN_DIGITS[Number(d)]!);
const L = (en: string, bn: string): Localized => ({ en, bn });

const REPLY_TIME: Record<InboxReplyTime, Localized> = {
  minutes: L('Replies in a few minutes', 'কয়েক মিনিটে উত্তর দেয়'),
  hour: L('Replies in about an hour', 'প্রায় এক ঘণ্টার মধ্যে উত্তর দেয়'),
  day: L('Replies within a day', 'এক দিনের মধ্যে উত্তর দেয়'),
};
const REPLY_WHEN: Record<InboxReplyTime, Localized> = {
  minutes: L('in a few minutes', 'কয়েক মিনিটের মধ্যে'),
  hour: L('within about an hour', 'প্রায় এক ঘণ্টার মধ্যে'),
  day: L('within a day', 'এক দিনের মধ্যে'),
};

export const INBOX_COPY = {
  launcher: L('Chat with us', 'চ্যাট করুন'),
  launcherUnread: (n: number) => L(`Chat with us, ${n} new ${n === 1 ? 'reply' : 'replies'}`, `চ্যাট করুন, ${bnDigits(n)}টি নতুন উত্তর`),
  teaser: L('Questions about sizes or delivery? We reply in minutes.', 'সাইজ বা ডেলিভারি নিয়ে প্রশ্ন? আমরা কয়েক মিনিটে উত্তর দিই।'),
  dismissTeaser: L('Dismiss', 'বন্ধ করুন'),
  close: L('Close chat', 'চ্যাট বন্ধ করুন'),
  dialogLabel: (shop: string) => L(`Chat with ${shop}`, `${shop}-এর সাথে চ্যাট`),
  replyTime: (t: InboxReplyTime) => REPLY_TIME[t],
  askingAbout: L('Asking about', 'জানতে চাইছেন'),
  name: L('Your name', 'আপনার নাম'),
  mobile: L('Mobile number', 'মোবাইল নম্বর'),
  mobileHelp: L('We text you when we reply', 'উত্তর দিলে আমরা আপনাকে SMS করব'),
  message: L('Message', 'মেসেজ'),
  addFile: L('Add a photo or PDF', 'ছবি বা PDF যোগ করুন'),
  fileLimit: L('up to 5 MB', 'সর্বোচ্চ ৫ MB'),
  removeFile: (name: string) => L(`Remove ${name}`, `${name} সরান`),
  send: L('Send message', 'মেসেজ পাঠান'),
  sendShort: L('Send', 'পাঠান'),
  sending: L('Sending…', 'পাঠানো হচ্ছে…'),
  privacy: L('Your number is only used for this chat and order updates.', 'আপনার নম্বর শুধু এই চ্যাট ও অর্ডারের আপডেটের জন্য ব্যবহার হয়।'),
  nameRequired: L('Enter your name.', 'আপনার নাম লিখুন।'),
  phoneInvalid: L('Enter a Bangladeshi mobile number (01XXXXXXXXX).', 'একটি বাংলাদেশি মোবাইল নম্বর লিখুন (01XXXXXXXXX)।'),
  messageRequired: L('Write a message.', 'একটি মেসেজ লিখুন।'),
  messageTooLong: (max: number) => L(`Keep it under ${max} characters.`, `${bnDigits(max)} অক্ষরের মধ্যে লিখুন।`),
  fileType: L('Only JPG, PNG or PDF files.', 'শুধু JPG, PNG বা PDF ফাইল।'),
  fileSize: L('That file is over 5 MB.', 'ফাইলটি ৫ MB-এর বেশি।'),
  fileEmpty: L('That file is empty.', 'ফাইলটি খালি।'),
  // code step (§9.3; composed, Figma has none)
  codeTitle: L('Check your phone', 'আপনার ফোন দেখুন'),
  codeHelp: (masked: string) => L(`Enter the 6-digit code we sent to ${masked}.`, `${masked} নম্বরে পাঠানো ৬ সংখ্যার কোডটি লিখুন।`),
  codeLabel: L('6-digit code', '৬ সংখ্যার কোড'),
  codeWaiting: L('Your message goes to the shop as soon as you enter the code.', 'কোডটি লিখলেই আপনার মেসেজ দোকানে পৌঁছে যাবে।'),
  verify: L('Confirm and send', 'যাচাই করে পাঠান'),
  verifying: L('Checking…', 'যাচাই হচ্ছে…'),
  resend: L('Resend code', 'আবার কোড পাঠান'),
  resendIn: (s: number) => L(`Resend in ${s} s`, `${bnDigits(s)} সেকেন্ড পরে আবার পাঠান`),
  resent: L('We sent a new code.', 'নতুন কোড পাঠানো হয়েছে।'),
  changeNumber: L('Change number', 'নম্বর বদলান'),
  codeRequired: L('Enter the 6-digit code.', '৬ সংখ্যার কোডটি লিখুন।'),
  codeInvalid: (left: number | null) =>
    left === null
      ? L("That code isn't right.", 'কোডটি সঠিক নয়।')
      : left <= 0
        ? L("That code isn't right. Send a new code.", 'কোডটি সঠিক নয়। নতুন কোড পাঠান।')
        : L(`That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, `কোডটি সঠিক নয়। আর ${bnDigits(left)} বার চেষ্টা করতে পারবেন।`),
  codeExpired: L('That code has expired. Send a new code.', 'কোডের মেয়াদ শেষ। নতুন কোড পাঠান।'),
  // thread
  greeting: L(
    'Assalamu alaikum! Ask about sizes, delivery or an order — we reply right here and by SMS.',
    'আসসালামু আলাইকুম! সাইজ, ডেলিভারি বা অর্ডার নিয়ে জিজ্ঞেস করুন — আমরা এখানেই ও SMS-এ উত্তর দিই।',
  ),
  sentAt: (time: string) => L(`Sent · ${time}`, `পাঠানো · ${time}`),
  seen: L('Seen', 'দেখেছে'),
  you: L('You', 'আপনি'),
  thanks: (name: string, masked: string, t: InboxReplyTime) =>
    L(
      `Thanks, ${name}! We usually reply ${REPLY_WHEN[t].en}, and we'll text ${masked} when we do.`,
      `ধন্যবাদ, ${name}! আমরা সাধারণত ${REPLY_WHEN[t].bn} উত্তর দিই, আর উত্তর দিলে ${masked} নম্বরে SMS করব।`,
    ),
  unverified: L(
    "We couldn't text you a code right now. Your message is with the shop — keep this page open or come back on this device to see the reply.",
    'এখন আপনাকে কোড পাঠানো যায়নি। আপনার মেসেজ দোকানে পৌঁছেছে — উত্তর দেখতে এই পেজ খোলা রাখুন বা এই ডিভাইসে আবার আসুন।',
  ),
  composer: L('Write a message…', 'মেসেজ লিখুন…'),
  attach: L('Attach a photo or PDF', 'ছবি বা PDF যুক্ত করুন'),
  notSent: L('Not sent · Tap to retry', 'পাঠানো যায়নি · আবার চেষ্টা করতে চাপুন'),
  newMessage: (shop: string) => L(`New message from ${shop}`, `${shop} থেকে নতুন মেসেজ`),
  photo: L('Photo', 'ছবি'),
  pdf: L('PDF', 'PDF'),
  processing: L('Processing…', 'প্রসেস হচ্ছে…'),
  loading: L('Loading messages…', 'মেসেজ লোড হচ্ছে…'),
  // states
  offline: L("You're offline. Messages will update when you're back online.", 'আপনি অফলাইনে আছেন। ইন্টারনেট ফিরলে মেসেজ আপডেট হবে।'),
  rateLimited: L('Too many messages. Wait a minute and try again.', 'অনেক বেশি মেসেজ। এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।'),
  rateLimitedFor: (s: number) => L(`Too many tries. Try again in ${s} s.`, `অনেকবার চেষ্টা হয়েছে। ${bnDigits(s)} সেকেন্ড পরে আবার চেষ্টা করুন।`),
  error: L('Something went wrong. Try again.', 'কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।'),
  loadError: L("Couldn't load messages.", 'মেসেজ লোড করা যায়নি।'),
  retry: L('Try again', 'আবার চেষ্টা করুন'),
  unavailable: L("Chat isn't available right now.", 'এই মুহূর্তে চ্যাট চালু নেই।'),
  sessionEnded: L('Your chat ended on this device. Send a new message to start again.', 'এই ডিভাইসে আপনার চ্যাট শেষ হয়েছে। আবার শুরু করতে নতুন মেসেজ পাঠান।'),
  // order Messages card (§10)
  orderTitle: L('Messages', 'মেসেজ'),
  orderPlaceholder: L('Write a message about this order…', 'এই অর্ডার নিয়ে মেসেজ লিখুন…'),
  orderAttach: L('Attach photo or PDF', 'ছবি বা PDF যুক্ত করুন'),
  orderNote: L('We also text you when the shop replies. Messages stay with this order.', 'দোকান উত্তর দিলে আমরা SMS-ও পাঠাই। মেসেজগুলো এই অর্ডারের সাথে থাকে।'),
  orderEmpty: L('No messages yet. Ask the shop anything about this order.', 'এখনও কোনো মেসেজ নেই। এই অর্ডার নিয়ে দোকানকে যেকোনো প্রশ্ন করুন।'),
  orderExpired: L('This page has expired. Track your order again to send a message.', 'এই পেজের মেয়াদ শেষ। মেসেজ পাঠাতে আবার অর্ডার ট্র্যাক করুন।'),
} as const;

/** Pick the language line. */
export const tr = (l: Localized, lang: Lang = DEFAULT_LANG): string => l[lang];

/** A route-handler error as the browser receives it. */
export interface ShopperError {
  status: number;
  code: string;
  details?: { attempts_left?: number; retry_after?: number; [k: string]: unknown };
}

/** Shopper-facing text for a chat/order-messages error (never the API's own message). */
export function inboxErrorText(e: ShopperError, lang: Lang = DEFAULT_LANG): string {
  switch (e.code) {
    case 'network_error':
      return tr(INBOX_COPY.offline, lang);
    case 'rate_limited':
      return typeof e.details?.retry_after === 'number' ? tr(INBOX_COPY.rateLimitedFor(e.details.retry_after), lang) : tr(INBOX_COPY.rateLimited, lang);
    case 'inbox_code_invalid':
      return tr(INBOX_COPY.codeInvalid(typeof e.details?.attempts_left === 'number' ? e.details.attempts_left : null), lang);
    case 'inbox_code_expired':
      return tr(INBOX_COPY.codeExpired, lang);
    case 'inbox_unavailable':
    case 'store_not_live':
      return tr(INBOX_COPY.unavailable, lang);
    case 'inbox_session_invalid':
      return tr(INBOX_COPY.sessionEnded, lang);
    case 'order_access_invalid':
      return tr(INBOX_COPY.orderExpired, lang);
    case 'validation_failed':
      if (e.details && 'file' in e.details) return tr(INBOX_COPY.fileType, lang);
      if (e.details && 'phone' in e.details) return tr(INBOX_COPY.phoneInvalid, lang);
      if (e.details && 'code' in e.details) return tr(INBOX_COPY.codeRequired, lang);
      return tr(INBOX_COPY.messageRequired, lang);
    default:
      return tr(INBOX_COPY.error, lang);
  }
}

import type { ParsedApiError } from './commerce-schemas';

/** Shopper-facing text for an API error (API messages are preferred when the API sent one). */
export function errorMessage(err: Pick<ParsedApiError, 'code' | 'message' | 'details'> & { status?: number }): string {
  const firstDetail = Object.values(err.details)[0]?.[0];
  switch (err.code) {
    case 'network_error':
    case 'invalid_payload':
      return "We couldn't reach the shop. Check your connection and try again.";
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.';
    case 'cart_not_found':
      return 'Your bag has expired. Add the items again.';
    case 'store_not_live':
      return err.message || "Your shop isn't live yet. Orders open after you go live.";
    case 'out_of_stock':
      return err.details.quantity?.[0] ?? firstDetail ?? (err.message || 'This item is out of stock.');
    case 'coupon_invalid':
      return err.details.code?.[0] ?? (err.message || "This code can't be used.");
    case 'validation_failed':
      return err.details.variant_id?.[0] ?? err.details.lines?.[0] ?? firstDetail ?? (err.message || 'Check the highlighted fields.');
    case 'advance_required':
      return 'This shop collects the delivery charge in advance. Choose how to pay it.';
    case 'payment_method_unavailable':
      return "This payment method isn't available right now. Choose another one.";
    case 'payment_not_pending':
      return "This order can't be paid online any more. Check its status on Track order.";
    case 'provider_unavailable':
      return "The payment service isn't responding. Try again in a minute.";
    default:
      if (err.status !== undefined && err.status >= 500) return 'Something went wrong on our side. Try again.';
      return err.message || firstDetail || 'Something went wrong. Try again.';
  }
}

/**
 * Branded transactional email. Content is a short summary and a link into the app —
 * never salary, bank, identity or other sensitive data.
 */
export interface EmailBrand {
  brandName: string;
  productName: string;
  primaryColor: string;
  supportEmail: string | null;
  appUrl: string;
  locale?: string;
  logoUrl?: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderEmail(brand: EmailBrand, msg: { title: string; body?: string | null; link?: string | null; actionLabel?: string; mandatory?: boolean }) {
  const url = msg.link ? new URL(msg.link, brand.appUrl).toString() : brand.appUrl;
  const action = msg.actionLabel ?? 'Open';
  const subject = `${msg.title} · ${brand.brandName}`;
  // A security notice goes out whatever someone's preference, so the footer does not offer what it cannot do.
  const footer = msg.mandatory ? 'This is a security notice and cannot be turned off.' : 'You can turn off email notifications under My account.';
  const text = [
    msg.title,
    '',
    msg.body ?? '',
    '',
    `${action}: ${url}`,
    '',
    `— ${brand.brandName} (${brand.productName})`,
    brand.supportEmail ? `Need help? ${brand.supportEmail}` : '',
    footer,
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
  const html = `<!doctype html><html lang="${esc(brand.locale ?? 'en')}"><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1c2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dde2e8;border-radius:8px">
<tr><td style="padding:16px 24px;border-bottom:3px solid ${esc(brand.primaryColor)};font-weight:700;font-size:16px">${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.brandName)}" height="32" style="display:block;height:32px">` : esc(brand.brandName)}</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:18px;margin:0 0 12px">${esc(msg.title)}</h1>
${msg.body ? `<p style="margin:0 0 20px;line-height:1.5">${esc(msg.body)}</p>` : ''}
<a href="${esc(url)}" style="display:inline-block;background:${esc(brand.primaryColor)};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${esc(action)}</a>
</td></tr>
<tr><td style="padding:16px 24px;color:#5b6676;font-size:12px;border-top:1px solid #dde2e8">${esc(brand.productName)}${brand.supportEmail ? ` · Need help? <a href="mailto:${esc(brand.supportEmail)}">${esc(brand.supportEmail)}</a>` : ''}<br>${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
